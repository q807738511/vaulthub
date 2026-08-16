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
#include <sys/stat.h>
#include <sys/types.h>
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
static const char *media_root = "/media";

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
static int scan_directory(const char *base, const char *relative, struct buffer *out, int *first) {
  char dirpath[MAX_PATH_LEN]; int z = snprintf(dirpath,sizeof(dirpath),"%s%s%s",base,*relative?"/":"",relative); if (z<0 || (size_t)z>=sizeof(dirpath)) return -1;
  DIR *dir = opendir(dirpath); if (!dir) return -1; struct dirent *entry;
  while ((entry = readdir(dir))) {
    if (!strcmp(entry->d_name,".") || !strcmp(entry->d_name,"..")) continue;
    char rel[MAX_PATH_LEN], full[MAX_PATH_LEN];
    z = snprintf(rel,sizeof(rel),"%s%s%s",relative,*relative?"/":"",entry->d_name); if (z<0 || (size_t)z>=sizeof(rel)) continue;
    z = snprintf(full,sizeof(full),"%s/%s",base,rel); if (z<0 || (size_t)z>=sizeof(full)) continue;
    struct stat st; if (lstat(full,&st)) continue;
    if (S_ISDIR(st.st_mode)) { if (scan_directory(base,rel,out,first)) { closedir(dir); return -1; } }
    else if (S_ISREG(st.st_mode)) {
      char *e=json_escape(rel); if (!e || appendf(out,"%s{\"path\":\"%s\",\"size\":%lld,\"mtime\":%lld}",*first?"":",",e,(long long)st.st_size,(long long)st.st_mtime)) { free(e);closedir(dir);return -1; }
      free(e); *first=0;
    }
  }
  closedir(dir); return 0;
}
static void list_libraries(int fd) {
  struct library libs[MAX_LIBS]; int count=0; if (load_libraries(libs,&count)) { json_error(fd,500,"configuration read failed"); return; }
  struct buffer b={0}; if (appendf(&b,"{\"libraries\":[")) goto oom;
  for (int i=0;i<count;i++) {
    char *id=json_escape(libs[i].id),*name=json_escape(libs[i].name),*type=json_escape(libs[i].type),*path=json_escape(libs[i].path);
    if (!id||!name||!type||!path||appendf(&b,"%s{\"id\":\"%s\",\"name\":\"%s\",\"type\":\"%s\",\"path\":\"%s\",\"files\":[",i?",":"",id,name,type,path)) { free(id);free(name);free(type);free(path);goto oom; }
    free(id);free(name);free(type);free(path); int first=1;
    if (path_is_under(libs[i].path,media_root)) (void)scan_directory(libs[i].path,"",&b,&first);
    if (appendf(&b,"]}")) goto oom;
  }
  if (appendf(&b,"]}\n")) goto oom;
  send_headers(fd,200,"application/json",(off_t)b.len,NULL);
  (void)write(fd,b.data,b.len); free(b.data); return;
oom: free(b.data); json_error(fd,500,"out of memory");
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
  int type_ok=!strcmp(lib.type,"audio")||!strcmp(lib.type,"comic")||!strcmp(lib.type,"book");
  if (!valid_id(lib.id)||!*lib.name||!type_ok) { json_error(fd,400,"invalid id, name or type"); return; }
  char canonical[MAX_PATH_LEN]; struct stat st;
  if (!realpath(lib.path,canonical)||!path_is_under(canonical,media_root)||stat(canonical,&st)||!S_ISDIR(st.st_mode)) { json_error(fd,400,"path must be an existing directory under /media"); return; }
  snprintf(lib.path,sizeof(lib.path),"%s",canonical);
  struct library libs[MAX_LIBS]; int count=0;
  if (load_libraries(libs,&count)) { json_error(fd,500,"configuration unavailable"); return; }
  for (int i=0;i<count;i++) if (!strcmp(libs[i].id,lib.id)) {
    if (!strcmp(libs[i].name,lib.name) && !strcmp(libs[i].type,lib.type) && !strcmp(libs[i].path,lib.path)) {
      response(fd,200,"application/json","{\"ok\":true,\"existing\":true}");
    } else {
      json_error(fd,409,"id already exists with different library data");
    }
    return;
  }
  if (count>=MAX_LIBS) { json_error(fd,500,"configuration unavailable"); return; }
  libs[count++]=lib; if (save_libraries(libs,count)) { json_error(fd,500,"configuration write failed"); return; }
  response(fd,201,"application/json","{\"ok\":true}");
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
  if(!strcasecmp(e,".pdf"))return "application/pdf";
  if(!strcasecmp(e,".epub"))return "application/epub+zip";
  if(!strcasecmp(e,".cbz"))return "application/vnd.comicbook+zip";
  if(!strcasecmp(e,".cbr"))return "application/vnd.comicbook-rar";
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
static void serve_file(int fd, const char *method, const char *url, const char *request) {
  const char *prefix="/api/media/file/"; char decoded[MAX_PATH_LEN]; if (url_decode(url,decoded,sizeof(decoded))||strncmp(decoded,prefix,strlen(prefix))) { json_error(fd,400,"invalid path"); return; }
  char *id=decoded+strlen(prefix),*slash=strchr(id,'/'); if(!slash){json_error(fd,400,"file path required");return;} *slash=0; const char *rel=slash+1; if(!valid_id(id)||!safe_relative(rel)){json_error(fd,400,"invalid path");return;}
  struct library libs[MAX_LIBS];int count=0;if(load_libraries(libs,&count)){json_error(fd,500,"configuration unavailable");return;}const char *base=NULL;for(int i=0;i<count;i++)if(!strcmp(libs[i].id,id))base=libs[i].path;if(!base){json_error(fd,404,"library not found");return;}
  char candidate[MAX_PATH_LEN],canonical[MAX_PATH_LEN];int z=snprintf(candidate,sizeof(candidate),"%s/%s",base,rel);struct stat st;if(z<0||(size_t)z>=sizeof(candidate)||!realpath(candidate,canonical)||!path_is_under(canonical,base)||stat(canonical,&st)||!S_ISREG(st.st_mode)){json_error(fd,404,"file not found");return;}
  off_t start=0,end=st.st_size?st.st_size-1:0;int ranged=parse_range(request,st.st_size,&start,&end);char extra[256];if(ranged<0){snprintf(extra,sizeof(extra),"Content-Range: bytes */%lld\r\nAccept-Ranges: bytes\r\n",(long long)st.st_size);send_headers(fd,416,"application/json",0,extra);return;}
  off_t len=st.st_size?end-start+1:0;if(ranged)snprintf(extra,sizeof(extra),"Accept-Ranges: bytes\r\nContent-Range: bytes %lld-%lld/%lld\r\n",(long long)start,(long long)end,(long long)st.st_size);else snprintf(extra,sizeof(extra),"Accept-Ranges: bytes\r\n");send_headers(fd,ranged?206:200,mime_type(canonical),len,extra);if(!strcmp(method,"HEAD")||!len)return;
  int file=open(canonical,O_RDONLY);if(file<0)return;if(lseek(file,start,SEEK_SET)<0){close(file);return;}char buf[65536];off_t left=len;while(left>0){size_t want=left<(off_t)sizeof(buf)?(size_t)left:sizeof(buf);ssize_t n=read(file,buf,want);if(n<=0)break;size_t sent=0;while(sent<(size_t)n){ssize_t w=write(fd,buf+sent,(size_t)n-sent);if(w<=0){left=0;break;}sent+=(size_t)w;}left-=n;}close(file);
}
static void handle_client(int fd) {
  char *req=calloc(MAX_REQ+1,1);if(!req){close(fd);return;}size_t n=0,header_len=0,content_len=0;
  while(n<MAX_REQ){ssize_t got=read(fd,req+n,MAX_REQ-n);if(got<=0)break;n+=(size_t)got;req[n]=0;char *end=strstr(req,"\r\n\r\n");if(end){header_len=(size_t)(end+4-req);const char *cl=header_value(req,"Content-Length");if(cl)content_len=(size_t)strtoull(cl,NULL,10);if(content_len>MAX_REQ-header_len){json_error(fd,413,"request too large");free(req);close(fd);return;}if(n>=header_len+content_len)break;}}
  char method[16]={0},url[MAX_PATH_LEN]={0};if(!header_len||sscanf(req,"%15s %4095s",method,url)!=2){json_error(fd,400,"invalid request");goto done;}char *query=strchr(url,'?');if(query)*query++=0;
  if(!strcmp(url,"/healthz"))response(fd,200,"text/plain; charset=utf-8","ok");
  else if(!strcmp(url,"/api/media/libraries")&&!strcmp(method,"GET"))list_libraries(fd);
  else if(!strcmp(url,"/api/media/libraries")&&!strcmp(method,"POST"))add_library(fd,req+header_len,req);
  else if(!strcmp(url,"/api/media/libraries")&&!strcmp(method,"DELETE")) {
    const char *id=query&&strncmp(query,"id=",3)==0?query+3:""; char decoded_id[MAX_ID];
    if (url_decode(id,decoded_id,sizeof(decoded_id))) json_error(fd,400,"invalid id"); else delete_library(fd,decoded_id,req);
  }
  else if(!strncmp(url,"/api/media/file/",16)&&(!strcmp(method,"GET")||!strcmp(method,"HEAD")))serve_file(fd,method,url,req);
  else if(!strncmp(url,"/api/media/",11))json_error(fd,405,"method not allowed");else json_error(fd,404,"not found");
done:free(req);close(fd);
}
int main(void) {
  const char *configured_root=getenv("MEDIA_ROOT"),*configured_config=getenv("MEDIA_CONFIG");
  if(configured_root&&*configured_root)media_root=configured_root;
  if(configured_config&&*configured_config)config_path=configured_config;
  signal(SIGPIPE,SIG_IGN);int s=socket(AF_INET,SOCK_STREAM,0);if(s<0)return 1;int yes=1;setsockopt(s,SOL_SOCKET,SO_REUSEADDR,&yes,sizeof(yes));struct sockaddr_in addr={0};addr.sin_family=AF_INET;addr.sin_addr.s_addr=htonl(INADDR_LOOPBACK);addr.sin_port=htons(PORT);if(bind(s,(struct sockaddr*)&addr,sizeof(addr))||listen(s,32)){perror("media-api listen");return 1;}fprintf(stderr,"VaultHub media API listening on 127.0.0.1:%d\n",PORT);for(;;){int fd=accept(s,NULL,NULL);if(fd>=0)handle_client(fd);else if(errno!=EINTR)break;}close(s);return 0;
}
