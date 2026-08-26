package main

import (
 "context"
 "crypto/rand"
 "crypto/subtle"
 "encoding/hex"
 "encoding/json"
 "io"
 "log"
 "net/http"
 "os"
 "os/exec"
 "os/signal"
 "strings"
 "sync"
 "syscall"
 "time"
)

type manager struct { mu sync.RWMutex; sessions map[string]time.Time; token, username, password string; caddyConfig []byte; children []*exec.Cmd }
func (m *manager) reply(w http.ResponseWriter, code int, v any) { w.Header().Set("Content-Type","application/json"); w.WriteHeader(code); _=json.NewEncoder(w).Encode(v) }
func (m *manager) logged(r *http.Request) bool { c,e:=r.Cookie("vh_session"); if e!=nil{return false}; m.mu.RLock(); exp,ok:=m.sessions[c.Value]; m.mu.RUnlock(); return ok&&time.Now().Before(exp) }
func (m *manager) require(w http.ResponseWriter,r *http.Request) bool { if m.logged(r){return true}; m.reply(w,401,map[string]any{"ok":false,"error":"login required"}); return false }
func (m *manager) login(w http.ResponseWriter,r *http.Request) { if r.Method!="POST"{m.reply(w,405,map[string]any{"ok":false});return}; b,_:=io.ReadAll(io.LimitReader(r.Body,65536)); var x struct{Token string `json:"token"`; Username string `json:"username"`; Password string `json:"password"`}; if json.Unmarshal(b,&x)!=nil{m.reply(w,400,map[string]any{"ok":false,"error":"invalid json"});return}; tokenOK:=m.token!=""&&len(x.Token)==len(m.token)&&subtle.ConstantTimeCompare([]byte(x.Token),[]byte(m.token))==1; userOK:=len(x.Username)==len(m.username)&&len(x.Password)==len(m.password)&&subtle.ConstantTimeCompare([]byte(x.Username),[]byte(m.username))==1&&subtle.ConstantTimeCompare([]byte(x.Password),[]byte(m.password))==1; if !tokenOK&&!userOK{m.reply(w,401,map[string]any{"ok":false,"error":"invalid credentials"});return}; raw:=make([]byte,24);if _,e:=rand.Read(raw);e!=nil{m.reply(w,500,map[string]any{"ok":false});return}; sid:=hex.EncodeToString(raw);m.mu.Lock();m.sessions[sid]=time.Now().Add(12*time.Hour);m.mu.Unlock();http.SetCookie(w,&http.Cookie{Name:"vh_session",Value:sid,Path:"/",HttpOnly:true,SameSite:http.SameSiteLaxMode,MaxAge:43200});m.reply(w,200,map[string]any{"ok":true}) }
func (m *manager) health(w http.ResponseWriter,r *http.Request){m.reply(w,200,map[string]any{"ok":true,"service":"go-manager","time":time.Now().UTC()})}
func (m *manager) runtime(w http.ResponseWriter,r *http.Request){if !m.require(w,r){return};m.reply(w,200,map[string]any{"ok":true,"pid":os.Getpid(),"go":"go-manager","children":len(m.children)})}
func (m *manager) caddyConfigHandler(w http.ResponseWriter,r *http.Request){if !m.require(w,r){return};if r.Method=="GET"{m.mu.RLock();b:=append([]byte(nil),m.caddyConfig...);m.mu.RUnlock();m.reply(w,200,map[string]any{"ok":true,"caddyfile":string(b)});return};if r.Method!="POST"{m.reply(w,405,map[string]any{"ok":false});return};b,_:=io.ReadAll(io.LimitReader(r.Body,2<<20));var x struct{Caddyfile string `json:"caddyfile"`};if json.Unmarshal(b,&x)!=nil||!strings.Contains(x.Caddyfile,":8088"){m.reply(w,400,map[string]any{"ok":false,"error":"invalid caddyfile"});return};tmp:="/data/Caddyfile.go.tmp";if os.WriteFile(tmp,[]byte(x.Caddyfile),0644)!=nil{m.reply(w,500,map[string]any{"ok":false});return};if err:=exec.Command("/usr/bin/caddy","validate","--config",tmp,"--adapter","caddyfile").Run();err!=nil{os.Remove(tmp);m.reply(w,400,map[string]any{"ok":false,"error":"validation failed"});return};if err:=os.Rename(tmp,"/data/Caddyfile");err!=nil{m.reply(w,500,map[string]any{"ok":false});return};m.mu.Lock();m.caddyConfig=[]byte(x.Caddyfile);m.mu.Unlock();if err:=exec.Command("/usr/bin/caddy","reload","--config","/data/Caddyfile","--adapter","caddyfile").Run();err!=nil{m.reply(w,500,map[string]any{"ok":false,"error":"reload failed"});return};m.reply(w,200,map[string]any{"ok":true})}
func (m *manager) docker(w http.ResponseWriter,r *http.Request){if !m.require(w,r){return};host:=r.URL.Query().Get("host");nas:=os.Getenv("NAS_IP");if host!="127.0.0.1"&&host!="localhost"&&host!=nas{m.reply(w,400,map[string]any{"ok":false,"error":"remote scan requires authorized agent"});return};b,e:=exec.Command("/usr/bin/curl","-fsS","--unix-socket","/var/run/docker.sock","http://localhost/containers/json?all=1").Output();if e!=nil{m.reply(w,500,map[string]any{"ok":false,"error":"docker unavailable"});return};var v any;if json.Unmarshal(b,&v)!=nil{m.reply(w,502,map[string]any{"ok":false,"error":"invalid docker response"});return};m.reply(w,200,map[string]any{"ok":true,"containers":v})}
func (m *manager) routes() http.Handler { mux:=http.NewServeMux();mux.HandleFunc("/api/health",m.health);mux.HandleFunc("/api/login",m.login);mux.HandleFunc("/api/system/runtime",m.runtime);mux.HandleFunc("/api/admin/docker/scan",m.docker);mux.HandleFunc("/api/admin/caddyfile",m.caddyConfigHandler);mux.HandleFunc("/api/admin/caddy/config",m.caddyConfigHandler);return mux }
func start(bin string,args ...string)*exec.Cmd{c:=exec.Command(bin,args...);c.Stdout=os.Stdout;c.Stderr=os.Stderr;if err:=c.Start();err!=nil{log.Printf("start %s: %v",bin,err);return nil};return c}
func main(){ctx,stop:=signal.NotifyContext(context.Background(),syscall.SIGTERM,syscall.SIGINT);defer stop();if err:=os.MkdirAll("/data",0755);err!=nil{log.Fatal(err)};b,_:=os.ReadFile("/data/Caddyfile");if len(b)==0{b,_=os.ReadFile("/etc/caddy/Caddyfile");_ = os.WriteFile("/data/Caddyfile",b,0644)};m:=&manager{sessions:map[string]time.Time{},token:os.Getenv("ADMIN_TOKEN"),username:os.Getenv("ADMIN_USERNAME"),password:os.Getenv("ADMIN_PASSWORD"),caddyConfig:b};if m.username==""{m.username="ADMIN"};if m.password==""{m.password="ADMIN123"};for _,x:=range [][2]string{{"/usr/bin/media-api",""},{"/usr/bin/subtitle-api",""}}{if c:=start(x[0]);c!=nil{m.children=append(m.children,c)}};if c:=start("/usr/bin/caddy","run","--config","/data/Caddyfile","--adapter","caddyfile");c!=nil{m.children=append(m.children,c)};addr:=os.Getenv("MANAGER_ADDR");if addr==""{addr="127.0.0.1:9099"};srv:=&http.Server{Addr:addr,Handler:m.routes(),ReadHeaderTimeout:5*time.Second};go func(){log.Printf("go-manager listening on %s",addr);if e:=srv.ListenAndServe();e!=nil&&e!=http.ErrServerClosed{log.Printf("manager: %v",e)}}();<-ctx.Done();shutdown,_:=context.WithTimeout(context.Background(),10*time.Second);_ = srv.Shutdown(shutdown);for _,c:=range m.children{_ = c.Process.Signal(syscall.SIGTERM)};for _,c:=range m.children{_,_ = c.Process.Wait()}}
