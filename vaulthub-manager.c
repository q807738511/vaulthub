#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define LISTEN_PORT 9099
#define MAX_REQ 1048576

static const char *data_config = "/data/Caddyfile";
static const char *default_config = "/etc/caddy/Caddyfile";
static pid_t caddy_pid = -1;
static pid_t media_pid = -1;
static pid_t subtitle_pid = -1;

static const char *caddy_bin(void) {
  const char *p = getenv("CADDY_BIN");
  return (p && *p) ? p : "/usr/bin/caddy";
}

static void logmsg(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vfprintf(stderr, fmt, ap);
  fputc('\n', stderr);
  va_end(ap);
}

static int file_exists(const char *p) {
  struct stat st;
  return stat(p, &st) == 0 && S_ISREG(st.st_mode);
}

static char *read_file(const char *path, size_t *len_out) {
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  if (n < 0) { fclose(f); return NULL; }
  fseek(f, 0, SEEK_SET);
  char *buf = calloc((size_t)n + 1, 1);
  if (!buf) { fclose(f); return NULL; }
  size_t got = fread(buf, 1, (size_t)n, f);
  fclose(f);
  buf[got] = 0;
  if (len_out) *len_out = got;
  return buf;
}

static int write_file_atomic(const char *path, const char *data, size_t len) {
  char tmp[256];
  snprintf(tmp, sizeof(tmp), "%s.tmp.%d", path, getpid());
  FILE *f = fopen(tmp, "wb");
  if (!f) return -1;
  if (fwrite(data, 1, len, f) != len) { fclose(f); unlink(tmp); return -1; }
  if (fclose(f) != 0) { unlink(tmp); return -1; }
  return rename(tmp, path);
}

static int copy_file(const char *src, const char *dst) {
  size_t len = 0;
  char *buf = read_file(src, &len);
  if (!buf) return -1;
  int rc = write_file_atomic(dst, buf, len);
  free(buf);
  return rc;
}

static void ensure_data_config(void) {
  mkdir("/data", 0755);
  if (!file_exists(data_config)) {
    if (copy_file(default_config, data_config) != 0) {
      logmsg("failed to initialize %s from %s: %s", data_config, default_config, strerror(errno));
      exit(1);
    }
  }
  size_t len = 0;
  char *cfg = read_file(data_config, &len);
  const char *marker = "handle /api/media/*";
  const char *system_marker = "handle /api/system/*";
  const char *subtitle_marker = "/api/media/subtitles/download";
  const char *admin = "	handle /api/admin/* {";
  if (cfg && (!strstr(cfg, marker) || !strstr(cfg, system_marker) || !strstr(cfg, subtitle_marker))) {
    char *pos = strstr(cfg, admin);
    if (pos) {
      const char *subtitle_block = strstr(cfg, subtitle_marker) ? "" : "\n	# Go 在线字幕下载代理。\n	handle /api/media/subtitles/download {\n		reverse_proxy http://127.0.0.1:9120\n	}\n";
      const char *system_block = strstr(cfg, system_marker) ? "" : "\n	# VaultHub 内置系统监控 API。\n	handle /api/system/* {\n		reverse_proxy http://127.0.0.1:9100 {\n			flush_interval -1\n		}\n	}\n";
      const char *media_block = strstr(cfg, marker) ? "" : "\n	# 本地媒体库 API，仅由同容器内绑定回环地址的进程处理。\n	handle /api/media/* {\n		reverse_proxy http://127.0.0.1:9100 {\n			flush_interval -1\n		}\n	}\n";
      size_t prefix = (size_t)(pos - cfg);
      size_t extra_len = strlen(subtitle_block) + strlen(system_block) + strlen(media_block);
      size_t out_len = len + extra_len;
      char *out = malloc(out_len + 1);
      if (!out) { free(cfg); logmsg("failed to allocate caddy migration buffer"); exit(1); }
      memcpy(out, cfg, prefix);
      memcpy(out + prefix, subtitle_block, strlen(subtitle_block));
      memcpy(out + prefix + strlen(subtitle_block), system_block, strlen(system_block));
      memcpy(out + prefix + strlen(subtitle_block) + strlen(system_block), media_block, strlen(media_block));
      memcpy(out + prefix + extra_len, cfg + prefix, len - prefix);
      out[out_len] = 0;
      if (write_file_atomic(data_config, out, out_len) != 0) {
        logmsg("failed to migrate %s for API routes: %s", data_config, strerror(errno));
        free(out); free(cfg); exit(1);
      }
      free(out);
    }
  }
  free(cfg);
}

static int run_cmd(char *const argv[]) {
  pid_t p = fork();
  if (p < 0) return -1;
  if (p == 0) {
    execv(argv[0], argv);
    _exit(127);
  }
  int st = 0;
  if (waitpid(p, &st, 0) < 0) return -1;
  return WIFEXITED(st) ? WEXITSTATUS(st) : 128;
}

static void start_caddy(void) {
  caddy_pid = fork();
  if (caddy_pid < 0) {
    logmsg("failed to fork caddy: %s", strerror(errno));
    exit(1);
  }
  if (caddy_pid == 0) {
    char *argv[] = {(char*)caddy_bin(), "run", "--config", "/data/Caddyfile", "--adapter", "caddyfile", NULL};
    execv(argv[0], argv);
    _exit(127);
  }
}

static void start_media_api(void) {
  media_pid = fork();
  if (media_pid < 0) {
    logmsg("failed to fork media API: %s", strerror(errno));
    exit(1);
  }
  if (media_pid == 0) {
    const char *bin = getenv("MEDIA_API_BIN");
    if (!bin || !*bin) bin = "/usr/bin/media-api";
    char *argv[] = {(char*)bin, NULL};
    execv(argv[0], argv);
    _exit(127);
  }
}

static void start_subtitle_api(void) {
  subtitle_pid = fork();
  if (subtitle_pid < 0) { logmsg("failed to fork subtitle API: %s", strerror(errno)); exit(1); }
  if (subtitle_pid == 0) {
    const char *bin = getenv("SUBTITLE_API_BIN"); if (!bin || !*bin) bin = "/usr/bin/subtitle-api";
    char *argv[] = {(char*)bin, NULL}; execv(argv[0], argv); _exit(127);
  }
}

static void stop_caddy(int sig) {
  (void)sig;
  if (caddy_pid > 0) kill(caddy_pid, SIGTERM);
  if (media_pid > 0) kill(media_pid, SIGTERM);
  if (subtitle_pid > 0) kill(subtitle_pid, SIGTERM);
}

static void send_resp(int fd, int code, const char *ctype, const char *body) {
  const char *msg = code == 200 ? "OK" : code == 204 ? "No Content" : code == 400 ? "Bad Request" : code == 401 ? "Unauthorized" : code == 500 ? "Internal Server Error" : "Error";
  size_t len = body ? strlen(body) : 0;
  dprintf(fd, "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", code, msg, ctype, len);
  if (len) write(fd, body, len);
}

static char *json_escape(const char *s) {
  size_t n = 0;
  for (const char *p = s; *p; p++) n += (*p == '\\' || *p == '"' || *p == '\n' || *p == '\r' || *p == '\t') ? 2 : 1;
  char *out = malloc(n + 1), *q = out;
  if (!out) return NULL;
  for (const char *p = s; *p; p++) {
    if (*p == '\\') { *q++='\\'; *q++='\\'; }
    else if (*p == '"') { *q++='\\'; *q++='"'; }
    else if (*p == '\n') { *q++='\\'; *q++='n'; }
    else if (*p == '\r') { *q++='\\'; *q++='r'; }
    else if (*p == '\t') { *q++='\\'; *q++='t'; }
    else *q++ = *p;
  }
  *q = 0;
  return out;
}

static char *json_get_string(const char *body, const char *key) {
  char pat[128];
  snprintf(pat, sizeof(pat), "\"%s\"", key);
  char *p = strstr((char*)body, pat);
  if (!p) return NULL;
  p = strchr(p + strlen(pat), ':');
  if (!p) return NULL;
  p++;
  while (*p == ' ' || *p == '\n' || *p == '\r' || *p == '\t') p++;
  if (*p != '"') return NULL;
  p++;
  char *out = malloc(strlen(p) + 1), *q = out;
  if (!out) return NULL;
  while (*p && *p != '"') {
    if (*p == '\\') {
      p++;
      if (*p == 'n') *q++ = '\n';
      else if (*p == 'r') *q++ = '\r';
      else if (*p == 't') *q++ = '\t';
      else if (*p) *q++ = *p;
      if (*p) p++;
    } else *q++ = *p++;
  }
  *q = 0;
  return out;
}

static const char *query_value(const char *path, const char *key, char *out, size_t cap) {
  const char *q = strchr(path, '?'); if (!q) return NULL; q++;
  size_t keylen = strlen(key);
  while (*q) {
    const char *eq = strchr(q, '='); if (!eq) break;
    const char *amp = strchr(eq + 1, '&'); size_t n = amp ? (size_t)(amp - eq - 1) : strlen(eq + 1);
    if ((size_t)(eq - q) == keylen && !strncmp(q, key, keylen) && n < cap) { memcpy(out, eq + 1, n); out[n] = 0; return out; }
    q = amp ? amp + 1 : q + strlen(q);
  }
  return NULL;
}

static void docker_scan(int fd, const char *path) {
  char host[128] = ""; query_value(path, "host", host, sizeof(host));
  const char *nas = getenv("NAS_IP"); if (!nas || !*nas) nas = "127.0.0.1";
  if (!host[0] || (strcmp(host, "127.0.0.1") && strcmp(host, "localhost") && strcmp(host, nas))) {
    send_resp(fd, 400, "application/json", "{\"ok\":false,\"error\":\"remote scan requires SSH or agent authorization\"}"); return;
  }
  FILE *p = popen("curl -fsS --unix-socket /var/run/docker.sock 'http://localhost/containers/json?all=1' 2>/dev/null", "r");
  if (!p) { send_resp(fd, 500, "application/json", "{\"ok\":false,\"error\":\"docker command unavailable\"}"); return; }
  char line[8192]; size_t cap = 65536, len = 0; char *body = calloc(cap, 1); if (!body) { pclose(p); send_resp(fd, 500, "application/json", "{\"ok\":false,\"error\":\"memory unavailable\"}"); return; }
  snprintf(body, cap, "{\"ok\":true,\"host\":\"%s\",\"containers\":", host); len = strlen(body);
  while (fgets(line, sizeof(line), p)) { size_t n = strlen(line); if (len + n + 3 >= cap) break; memcpy(body + len, line, n); len += n; body[len] = 0; }
  int rc = pclose(p); if (rc != 0 || len == 0 || body[len-1] == ':') { free(body); send_resp(fd, 500, "application/json", "{\"ok\":false,\"error\":\"Docker socket unavailable; mount /var/run/docker.sock read-only\"}"); return; }
  strcat(body, "}"); send_resp(fd, 200, "application/json", body); free(body);
}

/* Legacy C helper is retained only for source compatibility tests. The
 * production Go manager owns login sessions; this helper no longer accepts a
 * separate management token. */
static int authorized(const char *req) {
  (void)req;
  return 0;
}

static void handle_client(int fd) {
  char *req = calloc(MAX_REQ + 1, 1);
  if (!req) { close(fd); return; }
  ssize_t n = read(fd, req, MAX_REQ);
  if (n <= 0) { free(req); close(fd); return; }
  req[n] = 0;
  char method[16] = {0}, path[256] = {0};
  sscanf(req, "%15s %255s", method, path);

  char *body = strstr(req, "\r\n\r\n");
  body = body ? body + 4 : req + n;
  int content_len = 0;
  char *cl = strcasestr(req, "\r\nContent-Length:");
  if (cl) content_len = atoi(strchr(cl + 2, ':') + 1);
  while ((int)(n - (body - req)) < content_len && n < MAX_REQ) {
    ssize_t got = read(fd, req + n, MAX_REQ - n);
    if (got <= 0) break;
    n += got; req[n] = 0; body = strstr(req, "\r\n\r\n") + 4;
  }

  if (strcmp(path, "/healthz") == 0) {
    send_resp(fd, 200, "text/plain; charset=utf-8", "ok");
  } else if (!strncmp(path, "/api/admin/docker/scan", 22) && strcmp(method, "GET") == 0) {
    if (!authorized(req)) send_resp(fd, 401, "application/json", "{\"ok\":false,\"error\":\"unauthorized\"}");
    else docker_scan(fd, path);
  } else if (strcmp(path, "/api/admin/caddyfile") == 0 && strcmp(method, "GET") == 0) {
    size_t len = 0; char *cfg = read_file(data_config, &len);
    if (!cfg) send_resp(fd, 500, "application/json", "{\"ok\":false,\"error\":\"read failed\"}");
    else { char *esc = json_escape(cfg); char *resp = NULL; asprintf(&resp, "{\"ok\":true,\"caddyfile\":\"%s\"}", esc ? esc : ""); send_resp(fd, 200, "application/json", resp); free(resp); free(esc); free(cfg); }
  } else if (strcmp(path, "/api/admin/caddyfile") == 0 && strcmp(method, "POST") == 0) {
    if (!authorized(req)) send_resp(fd, 401, "application/json", "{\"ok\":false,\"error\":\"unauthorized\"}");
    else {
      char *cfg = json_get_string(body, "caddyfile");
      if (!cfg || !strstr(cfg, ":8088")) send_resp(fd, 400, "application/json", "{\"ok\":false,\"error\":\"invalid caddyfile\"}");
      else {
        char backup[256]; snprintf(backup, sizeof(backup), "/data/Caddyfile.backup.%ld", (long)time(NULL));
        copy_file(data_config, backup);
        if (write_file_atomic(data_config, cfg, strlen(cfg)) != 0) send_resp(fd, 500, "application/json", "{\"ok\":false,\"error\":\"write failed\"}");
        else {
          char *val[] = {(char*)caddy_bin(), "validate", "--config", "/data/Caddyfile", "--adapter", "caddyfile", NULL};
          int v = run_cmd(val);
          if (v != 0) { copy_file(backup, data_config); send_resp(fd, 400, "application/json", "{\"ok\":false,\"error\":\"caddy validate failed, rolled back\"}"); }
          else {
            char *rel[] = {(char*)caddy_bin(), "reload", "--config", "/data/Caddyfile", "--adapter", "caddyfile", NULL};
            int r = run_cmd(rel);
            if (r != 0) send_resp(fd, 500, "application/json", "{\"ok\":false,\"error\":\"caddy reload failed\"}");
            else send_resp(fd, 200, "application/json", "{\"ok\":true}");
          }
        }
      }
      free(cfg);
    }
  } else {
    send_resp(fd, 404, "application/json", "{\"ok\":false,\"error\":\"not found\"}");
  }
  free(req); close(fd);
}

int main(void) {
  signal(SIGTERM, stop_caddy);
  ensure_data_config();
  start_media_api();
  start_subtitle_api();
  start_caddy();
  int s = socket(AF_INET, SOCK_STREAM, 0);
  int yes = 1; setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
  struct sockaddr_in addr; memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET; addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK); addr.sin_port = htons(LISTEN_PORT);
  if (bind(s, (struct sockaddr*)&addr, sizeof(addr)) != 0 || listen(s, 16) != 0) {
    logmsg("manager listen failed: %s", strerror(errno)); return 1;
  }
  logmsg("VaultHub manager listening on 127.0.0.1:%d", LISTEN_PORT);
  for (;;) {
    int fd = accept(s, NULL, NULL);
    if (fd >= 0) handle_client(fd);
    int st; while (waitpid(-1, &st, WNOHANG) > 0) {}
  }
}
