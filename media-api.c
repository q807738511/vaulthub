#define _GNU_SOURCE
#include <arpa/inet.h>
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/statvfs.h>
#include <pthread.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define PORT 9100
#define MAX_REQ (2 * 1024 * 1024)
#define MAX_LIBS 128
#define MAX_ID 64
#define MAX_NAME 256
#define MAX_TYPE 16
#define MAX_PATH_LEN 4096

struct library { char id[MAX_ID], name[MAX_NAME], type[MAX_TYPE], path[MAX_PATH_LEN]; };
struct buffer { char *data; size_t len, cap; };
static const char *config_path = "/data/media-libraries.json";
static const char *index_dir = "/data/media-index";
static unsigned scan_sleep_ms = 25;

static int appendf(struct buffer *b, const char *fmt, ...) {
  va_list ap, copy;
  va_start(ap, fmt); va_copy(copy, ap);
  int need = vsnprintf(NULL, 0, fmt, copy); va_end(copy);
  if (need < 0) { va_end(ap); return -1; }
  size_t wanted = b->len + (size_t)need + 1;
  if (wanted > b->cap) {
    size_t cap = b->cap ? b->cap : 1024;
    while (cap < wanted) cap *= 2;
    char *p = realloc(b->data, cap);
    if (!p) { va_end(ap); return -1; }
    b->data = p; b->cap = cap;
  }
  vsnprintf(b->data + b->len, b->cap - b->len, fmt, ap); va_end(ap);
  b->len += (size_t)need; return 0;
}
static void send_headers(int fd, int code, const char *type, off_t len, const char *extra) {
  const char *reason = code == 200 ? "OK" : code == 201 ? "Created" : code == 206 ? "Partial Content" : code == 400 ? "Bad Request" : code == 401 ? "Unauthorized" : code == 404 ? "Not Found" : code == 405 ? "Method Not Allowed" : code == 413 ? "Payload Too Large" : code == 416 ? "Range Not Satisfiable" : "Internal Server Error";
  dprintf(fd, "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %lld\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\n%sConnection: close\r\n\r\n", code, reason, type, (long long)len, extra ? extra : "");
}
static void response(int fd, int code, const char *type, const char *body) {
  size_t len = body ? strlen(body) : 0; send_headers(fd, code, type, (off_t)len, NULL);
  if (len) (void)write(fd, body, len);
}
static void send_stream_headers(int fd, int code, const char *type, const char *extra) {
  const char *reason = code == 200 ? "OK" : code == 400 ? "Bad Request" : code == 404 ? "Not Found" : "Internal Server Error";
  dprintf(fd, "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\n%sConnection: close\r\n\r\n", code, reason, type, extra ? extra : "");
}
static void json_error(int fd, int code, const char *msg) {
  struct buffer b = {0}; appendf(&b, "{\"ok\":false,\"error\":\"%s\"}", msg); response(fd, code, "application/json", b.data); free(b.data);
}
static char *read_file(const char *path, size_t *len) {
  FILE *f = fopen(path, "rb"); if (!f) return NULL;
  if (fseek(f, 0, SEEK_END) || ftell(f) < 0) { fclose(f); return NULL; }
  long n = ftell(f); rewind(f); if (n > MAX_REQ) { fclose(f); errno = EFBIG; return NULL; }
  char *p = calloc((size_t)n + 1, 1); if (!p) { fclose(f); return NULL; }
  *len = fread(p, 1, (size_t)n, f); fclose(f); p[*len] = 0; return p;
}
static int write_atomic(const char *path, const char *data, size_t len) {
  char tmp[160]; snprintf(tmp, sizeof(tmp), "%s.tmp.%ld", path, (long)getpid());
  FILE *f = fopen(tmp, "wb"); if (!f) return -1;
  int ok = fwrite(data, 1, len, f) == len && fflush(f) == 0 && fsync(fileno(f)) == 0 && fclose(f) == 0;
  if (!ok) { unlink(tmp); return -1; }
  if (rename(tmp, path)) { unlink(tmp); return -1; }
  return 0;
}
static char *json_escape(const char *s) {
  struct buffer b = {0};
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    if (*p == '"' || *p == '\\') { if (appendf(&b, "\\%c", *p)) goto fail; }
    else if (*p == '\n') { if (appendf(&b, "\\n")) goto fail; }
    else if (*p == '\r') { if (appendf(&b, "\\r")) goto fail; }
    else if (*p == '\t') { if (appendf(&b, "\\t")) goto fail; }
    else if (*p >= 32 && appendf(&b, "%c", *p)) goto fail;
  }
  if (!b.data) b.data = strdup("");
  return b.data;
fail: free(b.data); return NULL;
}
static int json_string(const char *obj, const char *key, char *out, size_t cap) {
  char pattern[80]; snprintf(pattern, sizeof(pattern), "\"%s\"", key);
  const char *p = strstr(obj, pattern); if (!p || !(p = strchr(p + strlen(pattern), ':'))) return -1;
  p++; while (isspace((unsigned char)*p)) p++; if (*p++ != '"') return -1;
  size_t n = 0;
  while (*p && *p != '"') {
    unsigned char c = (unsigned char)*p++;
    if (c == '\\') { c = (unsigned char)*p++; if (c == 'n') c='\n'; else if (c == 'r') c='\r'; else if (c == 't') c='\t'; }
    if (!c || n + 1 >= cap) return -1;
    out[n++] = (char)c;
  }
  if (*p != '"') return -1;
  out[n] = 0;
  return 0;
}
static int valid_id(const char *s) {
  if (!*s || strlen(s) >= MAX_ID) return 0;
  for (; *s; s++) if (!isalnum((unsigned char)*s) && *s!='-' && *s!='_' && *s!='.') return 0;
  return 1;
}
static int path_is_under(const char *path, const char *root) {
  char real[MAX_PATH_LEN], real_root[MAX_PATH_LEN];
  if (!realpath(path, real) || !realpath(root, real_root)) return 0;
  size_t n = strlen(real_root);
  return strcmp(real, real_root) == 0 || (strncmp(real, real_root, n) == 0 && real[n] == '/');
}
static int load_libraries(struct library *libs, int *count) {
  *count = 0; size_t len = 0; char *json = read_file(config_path, &len);
  if (!json) return errno == ENOENT ? 0 : -1;
  char *p = json;
  while ((p = strchr(p, '{')) && *count < MAX_LIBS) {
    char *end = strchr(p, '}'); if (!end) { free(json); return -1; }
    char saved = *end; *end = 0; struct library lib = {{0},{0},{0},{0}};
    int ok = !json_string(p,"id",lib.id,sizeof(lib.id)) && !json_string(p,"name",lib.name,sizeof(lib.name)) && !json_string(p,"type",lib.type,sizeof(lib.type)) && !json_string(p,"path",lib.path,sizeof(lib.path));
    *end = saved; if (!ok) { free(json); return -1; }
    libs[(*count)++] = lib; p = end + 1;
  }
  free(json); return 0;
}
static int save_libraries(const struct library *libs, int count) {
  struct buffer b = {0}; if (appendf(&b, "[\n")) return -1;
  for (int i=0; i<count; i++) {
    char *id=json_escape(libs[i].id), *name=json_escape(libs[i].name), *type=json_escape(libs[i].type), *path=json_escape(libs[i].path);
    if (!id || !name || !type || !path || appendf(&b,"  {\"id\":\"%s\",\"name\":\"%s\",\"type\":\"%s\",\"path\":\"%s\"}%s\n",id,name,type,path,i+1<count?",":"")) { free(id);free(name);free(type);free(path);free(b.data);return -1; }
    free(id); free(name); free(type); free(path);
  }
  if (appendf(&b, "]\n")) { free(b.data); return -1; }
  int rc = write_atomic(config_path, b.data, b.len); free(b.data); return rc;
}
static int scan_index_directory(const char *base, const char *relative, FILE *out, size_t *count) {
  char dirpath[MAX_PATH_LEN];
  int z = snprintf(dirpath, sizeof(dirpath), "%s%s%s", base, *relative ? "/" : "", relative);
  if (z < 0 || (size_t)z >= sizeof(dirpath)) return -1;
  DIR *dir = opendir(dirpath); if (!dir) return -1;
  struct dirent *entry;
  while ((entry = readdir(dir))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (!strcmp(entry->d_name, "@eaDir") || !strcmp(entry->d_name, ".cache") || !strcmp(entry->d_name, "#recycle")) continue;
    char rel[MAX_PATH_LEN], full[MAX_PATH_LEN];
    z = snprintf(rel, sizeof(rel), "%s%s%s", relative, *relative ? "/" : "", entry->d_name);
    if (z < 0 || (size_t)z >= sizeof(rel)) continue;
    z = snprintf(full, sizeof(full), "%s/%s", base, rel);
    if (z < 0 || (size_t)z >= sizeof(full)) continue;
    struct stat st; if (lstat(full, &st)) continue;
    if (S_ISDIR(st.st_mode)) {
      if (scan_index_directory(base, rel, out, count)) { closedir(dir); return -1; }
    } else if (S_ISREG(st.st_mode)) {
      if (fprintf(out, "%s\t%lld\t%lld\n", rel, (long long)st.st_size, (long long)st.st_mtime) < 0) { closedir(dir); return -1; }
      (*count)++;
      if (scan_sleep_ms) { struct timespec ts = {0, (long)scan_sleep_ms * 1000000L}; nanosleep(&ts, NULL); }
    }
  }
  closedir(dir); return 0;
}
static int index_path(const char *id, char *out, size_t cap) {
  if (!valid_id(id)) return -1;
  if (mkdir(index_dir, 0755) && errno != EEXIST) return -1;
  int n = snprintf(out, cap, "%s/%s.idx", index_dir, id);
  return n < 0 || (size_t)n >= cap ? -1 : 0;
}
static pthread_mutex_t scan_lock = PTHREAD_MUTEX_INITIALIZER;
struct scan_arg { struct library lib; };
static void *scan_worker(void *opaque) {
  struct scan_arg *arg = opaque; char path[MAX_PATH_LEN], tmp[MAX_PATH_LEN]; size_t count = 0;
  pthread_mutex_lock(&scan_lock);
  if (!index_path(arg->lib.id, path, sizeof(path))) {
    if (snprintf(tmp, sizeof(tmp), "%s.tmp.%ld", path, (long)getpid()) < 0 || strlen(path) + 32 >= sizeof(tmp)) { pthread_mutex_unlock(&scan_lock); free(arg); return NULL; }
    FILE *out = fopen(tmp, "wb");
    if (out) {
      int ok = scan_index_directory(arg->lib.path, "", out, &count) == 0 && fflush(out) == 0 && fsync(fileno(out)) == 0;
      if (fclose(out) != 0) ok = 0;
      if (ok) rename(tmp, path); else unlink(tmp);
    }
  }
  pthread_mutex_unlock(&scan_lock); free(arg); return NULL;
}
static void start_scan(const struct library *lib) {
  struct scan_arg *arg = malloc(sizeof(*arg)); if (!arg) return; arg->lib = *lib;
  pthread_t thread; if (pthread_create(&thread, NULL, scan_worker, arg) == 0) pthread_detach(thread); else free(arg);
}
static void list_libraries(int fd) {
  struct library libs[MAX_LIBS]; int count=0; if (load_libraries(libs,&count)) { json_error(fd,500,"configuration read failed"); return; }
  struct buffer b={0}; if (appendf(&b,"{\"libraries\":[")) goto oom;
  for (int i=0;i<count;i++) {
    char *id=json_escape(libs[i].id),*name=json_escape(libs[i].name),*type=json_escape(libs[i].type),*path=json_escape(libs[i].path);
    if (!id||!name||!type||!path||appendf(&b,"%s{\"id\":\"%s\",\"name\":\"%s\",\"type\":\"%s\",\"path\":\"%s\"}",i?",":"",id,name,type,path)) { free(id);free(name);free(type);free(path);goto oom; }
    free(id);free(name);free(type);free(path);
  }
  if (appendf(&b,"]}\n")) goto oom;
  send_headers(fd,200,"application/json",(off_t)b.len,NULL); (void)write(fd,b.data,b.len); free(b.data); return;
oom: free(b.data); json_error(fd,500,"out of memory");
}
static const char *query_value(const char *query, const char *key) {
  if (!query) return NULL;
  size_t n = strlen(key);
  const char *p = query;
  while (p && *p) { if (!strncmp(p,key,n) && p[n]=='=') return p+n+1; p=strchr(p,'&'); if(p)p++; }
  return NULL;
}
static void list_files(int fd, const char *query) {
  const char *raw_id=query_value(query,"id"), *raw_offset=query_value(query,"offset"), *raw_limit=query_value(query,"limit");
  char id[MAX_ID]; if(!raw_id){json_error(fd,400,"id is required");return;} size_t id_len=strcspn(raw_id,"&"); if(!id_len||id_len>=sizeof(id)){json_error(fd,400,"invalid id");return;} memcpy(id,raw_id,id_len);id[id_len]=0;
  if(!valid_id(id)){json_error(fd,400,"invalid id");return;} unsigned long offset=raw_offset?strtoul(raw_offset,NULL,10):0, limit=raw_limit?strtoul(raw_limit,NULL,10):100; if(!limit||limit>500)limit=100;
  char path[MAX_PATH_LEN]; if(index_path(id,path,sizeof(path))){json_error(fd,500,"index unavailable");return;} FILE *in=fopen(path,"rb");
  if(!in){ response(fd,200,"application/json","{\"status\":\"indexing\",\"total\":0,\"offset\":0,\"limit\":100,\"has_more\":false,\"files\":[]}"); return; }
  struct buffer files={0}; size_t total=0, emitted=0; char *line=NULL; size_t cap=0; ssize_t got;
  while((got=getline(&line,&cap,in))>=0){ char *tab1=strrchr(line,'\t'); if(!tab1)continue; *tab1++=0; char *tab2=strrchr(line,'\t'); if(!tab2)continue; *tab2++=0; if(total>=offset&&emitted<limit){char *e=json_escape(line);if(!e||appendf(&files,"%s{\"path\":\"%s\",\"size\":%lld,\"mtime\":%lld}",emitted?",":"",e,strtoll(tab1,NULL,10),strtoll(tab2,NULL,10))){free(e);free(line);fclose(in);free(files.data);json_error(fd,500,"out of memory");return;}free(e);emitted++;} total++; }
  free(line);fclose(in); struct buffer body={0}; appendf(&body,"{\"status\":\"ready\",\"total\":%zu,\"offset\":%lu,\"limit\":%lu,\"has_more\":%s,\"files\":[%s]}\n",total,offset,limit,offset+emitted<total?"true":"false",files.data?files.data:""); free(files.data);send_headers(fd,200,"application/json",(off_t)body.len,NULL);write(fd,body.data,body.len);free(body.data);
}
static int authorized(const char *request) {
  const char *token=getenv("ADMIN_TOKEN"); if (!token || !*token) return 1;
  const char *p=strcasestr(request,"\r\nX-VaultHub-Token:"); if (!p) return 0;
  p=strchr(p,':')+1; while (*p==' '||*p=='\t') p++; size_t n=strlen(token);
  return !strncmp(p,token,n) && (p[n]=='\r'||p[n]=='\n'||p[n]==' '||p[n]=='\t');
}
static void add_library(int fd, const char *body, const char *request) {
  if (!authorized(request)) { json_error(fd,401,"unauthorized"); return; }
  struct library lib={{0},{0},{0},{0}};
  if (json_string(body,"id",lib.id,sizeof(lib.id)) || json_string(body,"name",lib.name,sizeof(lib.name)) || json_string(body,"type",lib.type,sizeof(lib.type)) || json_string(body,"path",lib.path,sizeof(lib.path))) { json_error(fd,400,"id, name, type and path are required"); return; }
  int type_ok=!strcmp(lib.type,"audio")||!strcmp(lib.type,"comic")||!strcmp(lib.type,"book")||!strcmp(lib.type,"movie");
  if (!valid_id(lib.id)||!*lib.name||!type_ok) { json_error(fd,400,"invalid id, name or type"); return; }
  char canonical[MAX_PATH_LEN]; struct stat st;
  if (!realpath(lib.path,canonical)||stat(canonical,&st)||!S_ISDIR(st.st_mode)) { json_error(fd,400,"path must be an existing absolute directory"); return; }
  snprintf(lib.path,sizeof(lib.path),"%s",canonical);
  struct library libs[MAX_LIBS]; int count=0;
  if (load_libraries(libs,&count)) { json_error(fd,500,"configuration unavailable"); return; }
  for (int i=0;i<count;i++) if (!strcmp(libs[i].id,lib.id)) {
    if (!strcmp(libs[i].name,lib.name) && !strcmp(libs[i].type,lib.type) && !strcmp(libs[i].path,lib.path)) {
      start_scan(&libs[i]);
      response(fd,200,"application/json","{\"ok\":true,\"existing\":true,\"status\":\"indexing\"}");
    } else {
      json_error(fd,409,"id already exists with different library data");
    }
    return;
  }
  if (count>=MAX_LIBS) { json_error(fd,500,"configuration unavailable"); return; }
  libs[count++]=lib; if (save_libraries(libs,count)) { json_error(fd,500,"configuration write failed"); return; }
  start_scan(&lib);
  response(fd,201,"application/json","{\"ok\":true,\"status\":\"indexing\"}");
}
static void delete_library(int fd, const char *id, const char *request) {
  if (!authorized(request)) { json_error(fd,401,"unauthorized"); return; }
  if (!valid_id(id)) { json_error(fd,400,"invalid id"); return; }
  struct library libs[MAX_LIBS]; int count=0;
  if (load_libraries(libs,&count)) { json_error(fd,500,"configuration unavailable"); return; }
  int found=-1;
  for (int i=0;i<count;i++) if (!strcmp(libs[i].id,id)) { found=i; break; }
  if (found<0) { json_error(fd,404,"library not found"); return; }
  for (int i=found;i<count-1;i++) libs[i]=libs[i+1];
  if (save_libraries(libs,count-1)) { json_error(fd,500,"configuration write failed"); return; }
  char idx[MAX_PATH_LEN]; if (!index_path(id,idx,sizeof(idx))) unlink(idx);
  response(fd,200,"application/json","{\"ok\":true}");
}
static int url_decode(const char *src, char *dst, size_t cap) {
  size_t n=0; for (size_t i=0;src[i];i++) {
    unsigned char c=(unsigned char)src[i];
    if (c=='%') { if (!isxdigit((unsigned char)src[i+1])||!isxdigit((unsigned char)src[i+2])) return -1; char hex[3]={src[i+1],src[i+2],0}; c=(unsigned char)strtoul(hex,NULL,16);i+=2; }
    if (!c||n+1>=cap) return -1;
    dst[n++]=(char)c;
  }
  dst[n]=0; return 0;
}
static int url_decode_component(const char *src, char *dst, size_t cap) {
  size_t n = strcspn(src, "&");
  if (!n || n >= MAX_PATH_LEN) return -1;
  char encoded[MAX_PATH_LEN];
  for (size_t i = 0; i < n; i++) encoded[i] = src[i];
  encoded[n] = 0;
  return url_decode(encoded, dst, cap);
}
static int safe_relative(const char *path) {
  if (!*path||*path=='/'||strchr(path,'\\')) return 0;
  const char *p=path; while (*p) { const char *end=strchr(p,'/'); size_t n=end?(size_t)(end-p):strlen(p); if (!n||(n==1&&p[0]=='.')||(n==2&&p[0]=='.'&&p[1]=='.')) return 0; if (!end) break; p=end+1; }
  return 1;
}
static const char *mime_type(const char *p) {
  const char *e=strrchr(p,'.'); if(!e)return "application/octet-stream";
  if(!strcasecmp(e,".mp3"))return "audio/mpeg";
  if(!strcasecmp(e,".flac"))return "audio/flac";
  if(!strcasecmp(e,".m4a"))return "audio/mp4";
  if(!strcasecmp(e,".ogg"))return "audio/ogg";
  if(!strcasecmp(e,".wav"))return "audio/wav";
  if(!strcasecmp(e,".mp4"))return "video/mp4";
  if(!strcasecmp(e,".m4v"))return "video/mp4";
  if(!strcasecmp(e,".webm"))return "video/webm";
  if(!strcasecmp(e,".mkv"))return "video/x-matroska";
  if(!strcasecmp(e,".avi"))return "video/x-msvideo";
  if(!strcasecmp(e,".mov"))return "video/quicktime";
  if(!strcasecmp(e,".ts"))return "video/mp2t";
  if(!strcasecmp(e,".m2ts"))return "video/mp2t";
  if(!strcasecmp(e,".pdf"))return "application/pdf";
  if(!strcasecmp(e,".epub"))return "application/epub+zip";
  if(!strcasecmp(e,".mobi"))return "application/x-mobipocket-ebook";
  if(!strcasecmp(e,".azw")||!strcasecmp(e,".azw3"))return "application/vnd.amazon.ebook";
  if(!strcasecmp(e,".djvu")||!strcasecmp(e,".djv"))return "image/vnd.djvu";
  if(!strcasecmp(e,".doc"))return "application/msword";
  if(!strcasecmp(e,".docx"))return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if(!strcasecmp(e,".xps"))return "application/vnd.ms-xpsdocument";
  if(!strcasecmp(e,".cbz"))return "application/vnd.comicbook+zip";
  if(!strcasecmp(e,".cbr"))return "application/vnd.comicbook-rar";
  if(!strcasecmp(e,".cb7"))return "application/x-7z-compressed";
  if(!strcasecmp(e,".cbt"))return "application/x-tar";
  if(!strcasecmp(e,".cbl"))return "application/x-lzh-compressed";
  if(!strcasecmp(e,".zip"))return "application/zip";
  if(!strcasecmp(e,".rar"))return "application/vnd.rar";
  if(!strcasecmp(e,".7z"))return "application/x-7z-compressed";
  if(!strcasecmp(e,".tar"))return "application/x-tar";
  if(!strcasecmp(e,".lzh"))return "application/x-lzh-compressed";
  if(!strcasecmp(e,".jpg")||!strcasecmp(e,".jpeg"))return "image/jpeg";
  if(!strcasecmp(e,".png"))return "image/png";
  if(!strcasecmp(e,".webp"))return "image/webp";
  if(!strcasecmp(e,".txt"))return "text/plain; charset=utf-8";
  return "application/octet-stream";
}
static const char *header_value(const char *request, const char *name) {
  char pattern[100]; snprintf(pattern,sizeof(pattern),"\r\n%s:",name); const char *p=strcasestr(request,pattern); if (!p)return NULL; p=strchr(p,':')+1; while(*p==' '||*p=='\t')p++; return p;
}
static int parse_range(const char *request, off_t size, off_t *start, off_t *end) {
  const char *p=header_value(request,"Range"); if (!p) return 0; if (strncasecmp(p,"bytes=",6)) return -1; p+=6;
  char *tail=NULL; if (*p=='-') { long long suffix=strtoll(p+1,&tail,10); if(suffix<=0)return -1; if(suffix>size)suffix=size;*start=size-suffix;*end=size-1; }
  else { long long a=strtoll(p,&tail,10); if(tail==p||a<0||a>=size)return -1;*start=(off_t)a;if(*tail=='-'){tail++;if(isdigit((unsigned char)*tail)){long long z=strtoll(tail,&tail,10);if(z<a)return -1;*end=z>=size?size-1:(off_t)z;}else *end=size-1;}else return -1; }
  return (*tail=='\r'||*tail=='\n'||*tail==0)?1:-1;
}

static int shell_quote(const char *src, char *dst, size_t cap) {
  size_t n = 0; if (n + 1 >= cap) return -1; dst[n++] = '\'';
  for (const char *p = src; *p; p++) {
    if (*p == '\'') { const char *q = "'\\''"; for (int i=0;q[i];i++) { if (n + 1 >= cap) return -1; dst[n++] = q[i]; } }
    else { if (n + 1 >= cap) return -1; dst[n++] = *p; }
  }
  if (n + 2 >= cap) return -1;
  dst[n++] = '\'';
  dst[n] = 0;
  return 0;
}
static void scraper_status(int fd) {
  const char *key = getenv("TMDB_API_KEY");
  response(fd, 200, "application/json", key && *key ? "{\"default\":\"douban\",\"tmdb_enabled\":true}\n" : "{\"default\":\"douban\",\"tmdb_enabled\":false}\n");
}
static void tmdb_search(int fd, const char *query) {
  const char *key = getenv("TMDB_API_KEY");
  if (!key || !*key) { json_error(fd, 400, "TMDB_API_KEY is not configured"); return; }
  const char *raw = query_value(query, "query"); char title[512];
  if (!raw || url_decode_component(raw, title, sizeof(title))) { json_error(fd, 400, "query is required"); return; }
  char q_key[1024], q_title[1024], cmd[4096];
  if (shell_quote(key, q_key, sizeof(q_key)) || shell_quote(title, q_title, sizeof(q_title))) { json_error(fd, 400, "query too long"); return; }
  snprintf(cmd, sizeof(cmd), "curl -fsS --get 'https://api.themoviedb.org/3/search/multi' --data-urlencode api_key=%s --data-urlencode language=zh-CN --data-urlencode query=%s --data-urlencode page=1 --max-time 8", q_key, q_title);
  FILE *pipe = popen(cmd, "r"); if (!pipe) { json_error(fd, 500, "tmdb scrape unavailable"); return; }
  struct buffer b = {0}; char chunk[4096]; size_t got;
  while ((got = fread(chunk, 1, sizeof(chunk), pipe)) > 0) { if (b.len + got > MAX_REQ || appendf(&b, "%.*s", (int)got, chunk)) { free(b.data); pclose(pipe); json_error(fd, 500, "tmdb response too large"); return; } }
  int rc = pclose(pipe); if (rc != 0 || !b.data) { free(b.data); json_error(fd, 500, "tmdb scrape failed"); return; }
  send_headers(fd, 200, "application/json", (off_t)b.len, NULL); write(fd, b.data, b.len); free(b.data);
}

static int resolve_query_media_file(const char *query, char *canonical, size_t canonical_cap, char *rel, size_t rel_cap) {
  (void)canonical_cap;
  const char *raw_id=query_value(query,"id"),*raw_path=query_value(query,"path"); char id[MAX_ID],decoded_rel[MAX_PATH_LEN];
  if(!raw_id||!raw_path||url_decode_component(raw_id,id,sizeof(id))||url_decode_component(raw_path,decoded_rel,sizeof(decoded_rel))||!valid_id(id)||!safe_relative(decoded_rel)) return -1;
  struct library libs[MAX_LIBS];int count=0;if(load_libraries(libs,&count))return -2;const char *base=NULL;for(int i=0;i<count;i++)if(!strcmp(libs[i].id,id))base=libs[i].path;if(!base)return -3;
  char candidate[MAX_PATH_LEN];struct stat st;int z=snprintf(candidate,sizeof(candidate),"%s/%s",base,decoded_rel);
  if(z<0||(size_t)z>=sizeof(candidate)||!realpath(candidate,canonical)||!path_is_under(canonical,base)||stat(canonical,&st)||!S_ISREG(st.st_mode))return -3;
  if(rel&&rel_cap){snprintf(rel,rel_cap,"%s",decoded_rel);} return 0;
}
static int ffprobe_value(const char *canonical, const char *selector, char *out, size_t cap) {
  char q_file[8192], q_sel[128], cmd[12000]; if(shell_quote(canonical,q_file,sizeof(q_file))||shell_quote(selector,q_sel,sizeof(q_sel)))return -1;
  snprintf(cmd,sizeof(cmd),"ffprobe -v error -select_streams %s -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 %s 2>/dev/null",q_sel,q_file);
  FILE *pipe=popen(cmd,"r"); if(!pipe)return -1; if(!fgets(out,(int)cap,pipe))out[0]=0; int rc=pclose(pipe);
  out[strcspn(out,"\r\n")]=0; return rc==0?0:-1;
}
static int browser_audio_codec_ok(const char *codec) {
  return !strcmp(codec,"aac")||!strcmp(codec,"mp3")||!strcmp(codec,"opus")||!strcmp(codec,"vorbis")||!strcmp(codec,"flac");
}
static int browser_container_likely_ok(const char *rel) {
  const char *e=strrchr(rel,'.'); if(!e)return 0; e++;
  return !strcasecmp(e,"mp4")||!strcasecmp(e,"m4v")||!strcasecmp(e,"webm")||!strcasecmp(e,"ogv")||!strcasecmp(e,"ogg");
}
static int valid_hardware_accel(const char *value) {
  return value && (!strcmp(value,"auto")||!strcmp(value,"cpu")||!strcmp(value,"vaapi")||!strcmp(value,"qsv")||!strcmp(value,"cuda"));
}
static int ffmpeg_has_encoder(const char *encoder) {
  char cmd[512];
  if(!encoder || (strcmp(encoder,"h264_nvenc") && strcmp(encoder,"h264_qsv") && strcmp(encoder,"h264_vaapi")))return 0;
  if(snprintf(cmd,sizeof(cmd),"ffmpeg -hide_banner -encoders 2>/dev/null | grep -Eq '[[:space:]]%s([[:space:]]|$)'",encoder)<0)return 0;
  int rc=system(cmd); return rc!=-1&&WIFEXITED(rc)&&WEXITSTATUS(rc)==0;
}
static int dri_available(void) {
  const char *device=getenv("VAAPI_DEVICE"); if(!device||!*device)device="/dev/dri/renderD128";
  return access(device,R_OK|W_OK)==0;
}
static int cuda_available(void) {
   const char *visible=getenv("NVIDIA_VISIBLE_DEVICES");
   return access("/dev/nvidia0",R_OK)==0 || access("/dev/nvidiactl",R_OK)==0 ||
          access("/dev/nvidia-uvm",R_OK)==0 ||
          (visible&&*visible&&!strcmp(visible,"all")&&access("/proc/driver/nvidia/version",R_OK)==0);
}
static const char *query_component(const char *query,const char *key,char *out,size_t cap) {
  const char *raw=query_value(query,key); if(!raw)return NULL; size_t n=strcspn(raw,"&"); if(!n||n>=cap)return NULL; memcpy(out,raw,n);out[n]=0;return out;
}
static const char *hardware_accel_config(const char *query,char *requested,size_t requested_cap) {
  const char *configured=getenv("FFMPEG_HWACCEL");
  if(!configured||!*configured)configured="auto";
  char from_query[32]; const char *raw=query_component(query,"hw",from_query,sizeof(from_query));
  const char *choice=raw?raw:configured;
  if(!valid_hardware_accel(choice))choice="cpu";
  snprintf(requested,requested_cap,"%s",choice);
  if(!strcmp(choice,"cpu"))return "cpu";
  if(!strcmp(choice,"cuda"))return cuda_available()&&ffmpeg_has_encoder("h264_nvenc")?"cuda":"cpu";
  if(!strcmp(choice,"qsv"))return dri_available()&&ffmpeg_has_encoder("h264_qsv")?"qsv":"cpu";
  if(!strcmp(choice,"vaapi"))return dri_available()&&ffmpeg_has_encoder("h264_vaapi")?"vaapi":"cpu";
  if(cuda_available()&&ffmpeg_has_encoder("h264_nvenc"))return "cuda";
  if(dri_available()&&ffmpeg_has_encoder("h264_vaapi"))return "vaapi";
  return "cpu";
}
static void hardware_status(int fd) {
  char requested[32]; const char *selected=hardware_accel_config(NULL,requested,sizeof(requested));
  struct buffer b={0};
  appendf(&b,"{\"configured\":\"%s\",\"selected\":\"%s\",\"available\":{\"cpu\":true,\"vaapi\":%s,\"qsv\":%s,\"cuda\":%s},\"vaapi_device\":\"%s\"}\n",requested,selected,dri_available()&&ffmpeg_has_encoder("h264_vaapi")?"true":"false",dri_available()&&ffmpeg_has_encoder("h264_qsv")?"true":"false",cuda_available()&&ffmpeg_has_encoder("h264_nvenc")?"true":"false",getenv("VAAPI_DEVICE")&&*getenv("VAAPI_DEVICE")?getenv("VAAPI_DEVICE"):"/dev/dri/renderD128");
  send_headers(fd,200,"application/json",(off_t)b.len,NULL);write(fd,b.data,b.len);free(b.data);
}
static void probe_media(int fd, const char *query) {
  char canonical[MAX_PATH_LEN], rel[MAX_PATH_LEN]; int rc=resolve_query_media_file(query,canonical,sizeof(canonical),rel,sizeof(rel)); if(rc){json_error(fd,rc==-3?404:400,"invalid media path");return;}
  char acodec[64]="", vcodec[64]=""; (void)ffprobe_value(canonical,"a:0",acodec,sizeof(acodec)); (void)ffprobe_value(canonical,"v:0",vcodec,sizeof(vcodec));
  int compat = !browser_container_likely_ok(rel) || (acodec[0] && !browser_audio_codec_ok(acodec));
  char *eac=json_escape(acodec), *evc=json_escape(vcodec); struct buffer b={0};
  appendf(&b,"{\"audio_codec\":\"%s\",\"video_codec\":\"%s\",\"container_likely_supported\":%s,\"audio_likely_supported\":%s,\"compat_recommended\":%s}\n",eac?eac:"",evc?evc:"",browser_container_likely_ok(rel)?"true":"false",(!acodec[0]||browser_audio_codec_ok(acodec))?"true":"false",compat?"true":"false");
  free(eac);free(evc); send_headers(fd,200,"application/json",(off_t)b.len,NULL); write(fd,b.data,b.len); free(b.data);
}
static void compat_media(int fd, const char *method, const char *query) {
  char canonical[MAX_PATH_LEN]; int rc=resolve_query_media_file(query,canonical,sizeof(canonical),NULL,0); if(rc){json_error(fd,rc==-3?404:400,"invalid media path");return;}
  char requested[32]; const char *hardware=hardware_accel_config(query,requested,sizeof(requested));
  char extra[256]; snprintf(extra,sizeof(extra),"Accept-Ranges: none\r\nX-VaultHub-Compat: audio-aac\r\nX-VaultHub-Hardware: %s\r\n",hardware);
  if(!strcmp(method,"HEAD")){send_stream_headers(fd,200,"video/mp4",extra);return;}
  char q_file[8192], cmd[16000]; if(shell_quote(canonical,q_file,sizeof(q_file))){json_error(fd,400,"path too long");return;}
  if(!strcmp(hardware,"cuda")) snprintf(cmd,sizeof(cmd),"ffmpeg -hide_banner -loglevel error -i %s -map 0:v:0 -map 0:a:0? -c:v h264_nvenc -preset p4 -cq 23 -pix_fmt yuv420p -c:a aac -b:a 160k -ac 2 -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1 2>/dev/null",q_file);
  else if(!strcmp(hardware,"qsv")) snprintf(cmd,sizeof(cmd),"ffmpeg -hide_banner -loglevel error -hwaccel qsv -qsv_device '%s' -i %s -map 0:v:0 -map 0:a:0? -vf 'scale_qsv=format=nv12' -c:v h264_qsv -global_quality 23 -c:a aac -b:a 160k -ac 2 -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1 2>/dev/null",getenv("VAAPI_DEVICE")&&*getenv("VAAPI_DEVICE")?getenv("VAAPI_DEVICE"):"/dev/dri/renderD128",q_file);
  else if(!strcmp(hardware,"vaapi")) snprintf(cmd,sizeof(cmd),"ffmpeg -hide_banner -loglevel error -hwaccel vaapi -hwaccel_device '%s' -hwaccel_output_format vaapi -i %s -map 0:v:0 -map 0:a:0? -vf 'scale_vaapi=format=nv12' -c:v h264_vaapi -qp 23 -c:a aac -b:a 160k -ac 2 -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1 2>/dev/null",getenv("VAAPI_DEVICE")&&*getenv("VAAPI_DEVICE")?getenv("VAAPI_DEVICE"):"/dev/dri/renderD128",q_file);
  else snprintf(cmd,sizeof(cmd),"ffmpeg -hide_banner -loglevel error -i %s -map 0:v:0 -map 0:a:0? -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 160k -ac 2 -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1 2>/dev/null",q_file);
  FILE *pipe=popen(cmd,"r"); if(!pipe){json_error(fd,500,"compat playback unavailable");return;}
  send_stream_headers(fd,200,"video/mp4",extra); char buf[65536]; size_t n;
  while((n=fread(buf,1,sizeof(buf),pipe))>0){size_t sent=0;while(sent<n){ssize_t w=write(fd,buf+sent,n-sent);if(w<=0){pclose(pipe);return;}sent+=(size_t)w;}}
  pclose(pipe);
}
static void serve_file(int fd, const char *method, const char *url, const char *request) {
  const char *prefix="/api/media/file/"; char decoded[MAX_PATH_LEN]; if (url_decode(url,decoded,sizeof(decoded))||strncmp(decoded,prefix,strlen(prefix))) { json_error(fd,400,"invalid path"); return; }
  char *id=decoded+strlen(prefix),*slash=strchr(id,'/'); if(!slash){json_error(fd,400,"file path required");return;} *slash=0; const char *rel=slash+1; if(!valid_id(id)||!safe_relative(rel)){json_error(fd,400,"invalid path");return;}
  struct library libs[MAX_LIBS];int count=0;if(load_libraries(libs,&count)){json_error(fd,500,"configuration unavailable");return;}const char *base=NULL;for(int i=0;i<count;i++)if(!strcmp(libs[i].id,id))base=libs[i].path;if(!base){json_error(fd,404,"library not found");return;}
  char candidate[MAX_PATH_LEN],canonical[MAX_PATH_LEN];int z=snprintf(candidate,sizeof(candidate),"%s/%s",base,rel);struct stat st;if(z<0||(size_t)z>=sizeof(candidate)||!realpath(candidate,canonical)||!path_is_under(canonical,base)||stat(canonical,&st)||!S_ISREG(st.st_mode)){json_error(fd,404,"file not found");return;}
  off_t start=0,end=st.st_size?st.st_size-1:0;int ranged=parse_range(request,st.st_size,&start,&end);char extra[256];if(ranged<0){snprintf(extra,sizeof(extra),"Content-Range: bytes */%lld\r\nAccept-Ranges: bytes\r\n",(long long)st.st_size);send_headers(fd,416,"application/json",0,extra);return;}
  off_t len=st.st_size?end-start+1:0;if(ranged)snprintf(extra,sizeof(extra),"Accept-Ranges: bytes\r\nContent-Range: bytes %lld-%lld/%lld\r\n",(long long)start,(long long)end,(long long)st.st_size);else snprintf(extra,sizeof(extra),"Accept-Ranges: bytes\r\n");send_headers(fd,ranged?206:200,mime_type(canonical),len,extra);if(!strcmp(method,"HEAD")||!len)return;
  int file=open(canonical,O_RDONLY);if(file<0)return;if(lseek(file,start,SEEK_SET)<0){close(file);return;}char buf[65536];off_t left=len;while(left>0){size_t want=left<(off_t)sizeof(buf)?(size_t)left:sizeof(buf);ssize_t n=read(file,buf,want);if(n<=0)break;size_t sent=0;while(sent<(size_t)n){ssize_t w=write(fd,buf+sent,(size_t)n-sent);if(w<=0){left=0;break;}sent+=(size_t)w;}left-=n;}close(file);
}
static void serve_file_query(int fd, const char *method, const char *query, const char *request) {
  const char *raw_id=query_value(query,"id"),*raw_path=query_value(query,"path"); char id[MAX_ID],rel[MAX_PATH_LEN];
  if(!raw_id||!raw_path||url_decode_component(raw_id,id,sizeof(id))||url_decode_component(raw_path,rel,sizeof(rel))||!valid_id(id)||!safe_relative(rel)){json_error(fd,400,"invalid path");return;}
  struct library libs[MAX_LIBS];int count=0;if(load_libraries(libs,&count)){json_error(fd,500,"configuration unavailable");return;}const char *base=NULL;for(int i=0;i<count;i++)if(!strcmp(libs[i].id,id))base=libs[i].path;if(!base){json_error(fd,404,"library not found");return;}
  char candidate[MAX_PATH_LEN],canonical[MAX_PATH_LEN];int z=snprintf(candidate,sizeof(candidate),"%s/%s",base,rel);struct stat st;if(z<0||(size_t)z>=sizeof(candidate)||!realpath(candidate,canonical)||!path_is_under(canonical,base)||stat(canonical,&st)||!S_ISREG(st.st_mode)){json_error(fd,404,"file not found");return;}
  off_t start=0,end=st.st_size?st.st_size-1:0;int ranged=parse_range(request,st.st_size,&start,&end);char extra[256];if(ranged<0){snprintf(extra,sizeof(extra),"Content-Range: bytes */%lld\r\nAccept-Ranges: bytes\r\n",(long long)st.st_size);send_headers(fd,416,"application/json",0,extra);return;}
  off_t len=st.st_size?end-start+1:0;if(ranged)snprintf(extra,sizeof(extra),"Accept-Ranges: bytes\r\nContent-Range: bytes %lld-%lld/%lld\r\n",(long long)start,(long long)end,(long long)st.st_size);else snprintf(extra,sizeof(extra),"Accept-Ranges: bytes\r\n");send_headers(fd,ranged?206:200,mime_type(canonical),len,extra);if(!strcmp(method,"HEAD")||!len)return;
  int file=open(canonical,O_RDONLY);if(file<0)return;if(lseek(file,start,SEEK_SET)<0){close(file);return;}char buf[65536];off_t left=len;while(left>0){size_t want=left<(off_t)sizeof(buf)?(size_t)left:sizeof(buf);ssize_t n=read(file,buf,want);if(n<=0)break;size_t sent=0;while(sent<(size_t)n){ssize_t w=write(fd,buf+sent,(size_t)n-sent);if(w<=0){left=0;break;}sent+=(size_t)w;}left-=n;}close(file);
}
static double read_cpu_percent(const char *proc) {
  static unsigned long long old_total = 0, old_idle = 0;
  char path[MAX_PATH_LEN];
  snprintf(path, sizeof(path), "%s/stat", proc);
  FILE *f = fopen(path, "r"); if (!f) return 0.0;
  unsigned long long user=0,nice=0,system=0,idle=0,iowait=0,irq=0,softirq=0,steal=0;
  int ok = fscanf(f, "cpu %llu %llu %llu %llu %llu %llu %llu %llu", &user,&nice,&system,&idle,&iowait,&irq,&softirq,&steal) == 8;
  fclose(f); if (!ok) return 0.0;
  unsigned long long total=user+nice+system+idle+iowait+irq+softirq+steal;
  unsigned long long dt=total-old_total, di=idle+iowait-old_idle;
  old_total=total; old_idle=idle+iowait;
  return dt ? (double)(dt-di)*100.0/(double)dt : 0.0;
}
static void read_network(const char *proc, const char *wanted, double *rx, double *tx) {
  char path[MAX_PATH_LEN], line[512], name[64];
  snprintf(path, sizeof(path), "%s/net/dev", proc); FILE *f=fopen(path,"r");
  *rx=0.0; *tx=0.0; if (!f) return;
  while (fgets(line,sizeof(line),f)) {
    unsigned long long r=0,t=0,dummy[14]={0}; char *colon=strchr(line,':'); if (!colon) continue;
    if (sscanf(line," %63[^:]:",name)!=1 || !strcmp(name,"lo")) continue;
    if (*wanted && strcmp(name,wanted)) continue;
    if (sscanf(colon+1," %llu %llu %llu %llu %llu %llu %llu %llu %llu %llu %llu %llu %llu %llu %llu %llu",
      &r,&dummy[0],&dummy[1],&dummy[2],&dummy[3],&dummy[4],&dummy[5],&dummy[6],
      &t,&dummy[7],&dummy[8],&dummy[9],&dummy[10],&dummy[11],&dummy[12],&dummy[13]) != 16) continue;
    *rx=(double)r; *tx=(double)t; fclose(f); return;
  }
  fclose(f);
}

static void system_metrics(int fd) {
  const char *proc = getenv("SYSTEM_MONITOR_PROC_ROOT");
  const char *sys = getenv("SYSTEM_MONITOR_SYS_ROOT");
  const char *enabled = getenv("SYSTEM_MONITOR_ENABLED");
  const char *interface_name = getenv("SYSTEM_MONITOR_INTERFACE");
  if (!interface_name) interface_name = "";
  (void)interface_name;
  if (!proc || !*proc) proc = "/host/proc";
  if (!sys || !*sys) sys = "/host/sys";
  (void)sys;
  if (enabled && (!strcmp(enabled, "0") || !strcasecmp(enabled, "false"))) {
    response(fd, 200, "application/json", "{\"enabled\":false}");
    return;
  }
  char path[MAX_PATH_LEN], buf[8192];
  snprintf(path, sizeof(path), "%s/loadavg", proc);
  FILE *f = fopen(path, "r");
  double load = 0.0;
  if (f) { (void)fscanf(f, "%lf", &load); fclose(f); }
  snprintf(path, sizeof(path), "%s/meminfo", proc);
  f = fopen(path, "r");
  unsigned long long total = 0, available = 0;
  if (f) {
    while (fgets(buf, sizeof(buf), f)) {
      if (sscanf(buf, "MemTotal: %llu kB", &total) == 1) continue;
      (void)sscanf(buf, "MemAvailable: %llu kB", &available);
    }
    fclose(f);
  }
  unsigned long long used = total > available ? total - available : 0;
  double cpu_percent = read_cpu_percent(proc), rx = 0.0, tx = 0.0;
  read_network(proc, interface_name, &rx, &tx);
  struct buffer out = {0};
  appendf(&out, "{\"enabled\":true,\"cpu\":{\"percent\":%.2f,\"load1\":%.2f},\"memory\":{\"total\":%llu,\"used\":%llu,\"available\":%llu},\"network\":{\"rx_bytes\":%.0f,\"tx_bytes\":%.0f},\"filesystems\":[", cpu_percent, load, total * 1024ULL, used * 1024ULL, available * 1024ULL, rx, tx);
  const char *filesystems = getenv("SYSTEM_MONITOR_FILESYSTEMS");
  if (filesystems && *filesystems) {
    char list[4096]; snprintf(list, sizeof(list), "%s", filesystems);
    char *save = NULL; int first = 1;
    for (char *item = strtok_r(list, ",", &save); item; item = strtok_r(NULL, ",", &save)) {
      while (*item == ' ') item++;
      char mount[MAX_PATH_LEN];
      if (item[0] == '/') snprintf(mount, sizeof(mount), "%s", item);
      else snprintf(mount, sizeof(mount), "/host/%s", item);
      struct statvfs st;
      if (statvfs(mount, &st) != 0) continue;
      unsigned long long total_bytes = (unsigned long long)st.f_blocks * st.f_frsize;
      unsigned long long free_bytes = (unsigned long long)st.f_bavail * st.f_frsize;
      unsigned long long used_bytes = total_bytes > free_bytes ? total_bytes - free_bytes : 0;
      unsigned pct = total_bytes ? (unsigned)(used_bytes * 100ULL / total_bytes) : 0;
      appendf(&out, "%s{\"path\":\"%s\",\"total\":%llu,\"used\":%llu,\"percent\":%u}", first ? "" : ",", mount, total_bytes, used_bytes, pct);
      first = 0;
    }
  }
  appendf(&out, "]}\n");
  send_headers(fd, 200, "application/json", (off_t)out.len, NULL);
  (void)write(fd, out.data, out.len);
  free(out.data);
}

static void handle_client(int fd) {
  char *req=calloc(MAX_REQ+1,1);if(!req){close(fd);return;}size_t n=0,header_len=0,content_len=0;
  while(n<MAX_REQ){ssize_t got=read(fd,req+n,MAX_REQ-n);if(got<=0)break;n+=(size_t)got;req[n]=0;char *end=strstr(req,"\r\n\r\n");if(end){header_len=(size_t)(end+4-req);const char *cl=header_value(req,"Content-Length");if(cl)content_len=(size_t)strtoull(cl,NULL,10);if(content_len>MAX_REQ-header_len){json_error(fd,413,"request too large");free(req);close(fd);return;}if(n>=header_len+content_len)break;}}
  char method[16]={0},url[MAX_PATH_LEN]={0};if(!header_len||sscanf(req,"%15s %4095s",method,url)!=2){json_error(fd,400,"invalid request");goto done;}char *query=strchr(url,'?');if(query)*query++=0;
  if(!strcmp(url,"/healthz"))response(fd,200,"text/plain; charset=utf-8","ok");
  else if(!strcmp(url,"/api/system/metrics")&&!strcmp(method,"GET"))system_metrics(fd);
  else if(!strcmp(url,"/api/media/libraries")&&!strcmp(method,"GET"))list_libraries(fd);
  else if(!strcmp(url,"/api/media/files")&&!strcmp(method,"GET"))list_files(fd,query);
  else if(!strcmp(url,"/api/media/scrapers")&&!strcmp(method,"GET"))scraper_status(fd);
  else if(!strcmp(url,"/api/media/hardware")&&!strcmp(method,"GET"))hardware_status(fd);
  else if(!strcmp(url,"/api/media/tmdb")&&!strcmp(method,"GET"))tmdb_search(fd,query);
  else if(!strcmp(url,"/api/media/probe")&&query&&!strcmp(method,"GET"))probe_media(fd,query);
  else if(!strcmp(url,"/api/media/compat")&&query&&(!strcmp(method,"GET")||!strcmp(method,"HEAD")))compat_media(fd,method,query);
  else if(!strcmp(url,"/api/media/libraries")&&!strcmp(method,"POST"))add_library(fd,req+header_len,req);
  else if(!strcmp(url,"/api/media/libraries")&&!strcmp(method,"DELETE")) {
    const char *id=query&&strncmp(query,"id=",3)==0?query+3:""; char decoded_id[MAX_ID];
    if (url_decode(id,decoded_id,sizeof(decoded_id))) json_error(fd,400,"invalid id"); else delete_library(fd,decoded_id,req);
  }
  else if(!strcmp(url,"/api/media/file")&&query&&(!strcmp(method,"GET")||!strcmp(method,"HEAD")))serve_file_query(fd,method,query,req);
  else if(!strncmp(url,"/api/media/file/",16)&&(!strcmp(method,"GET")||!strcmp(method,"HEAD")))serve_file(fd,method,url,req);
  else if(!strncmp(url,"/api/media/",11))json_error(fd,405,"method not allowed");else json_error(fd,404,"not found");
done:free(req);close(fd);
}
int main(void) {
  const char *configured_config=getenv("MEDIA_CONFIG"); if(configured_config&&*configured_config)config_path=configured_config;
  const char *configured_index=getenv("MEDIA_INDEX_DIR"); if(configured_index&&*configured_index)index_dir=configured_index;
  const char *configured_sleep=getenv("MEDIA_SCAN_SLEEP_MS"); if(configured_sleep&&*configured_sleep)scan_sleep_ms=(unsigned)strtoul(configured_sleep,NULL,10);
  signal(SIGPIPE,SIG_IGN);int s=socket(AF_INET,SOCK_STREAM,0);if(s<0)return 1;int yes=1;setsockopt(s,SOL_SOCKET,SO_REUSEADDR,&yes,sizeof(yes));struct sockaddr_in addr={0};addr.sin_family=AF_INET;addr.sin_addr.s_addr=htonl(INADDR_LOOPBACK);addr.sin_port=htons(PORT);if(bind(s,(struct sockaddr*)&addr,sizeof(addr))||listen(s,32)){perror("media-api listen");return 1;}fprintf(stderr,"VaultHub media API listening on 127.0.0.1:%d\n",PORT);for(;;){int fd=accept(s,NULL,NULL);if(fd>=0)handle_client(fd);else if(errno!=EINTR)break;}close(s);return 0;
}
