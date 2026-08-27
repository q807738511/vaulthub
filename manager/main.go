package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

type loginFailure struct {
	count int
	until time.Time
}
type manager struct {
	mu                        sync.RWMutex
	configMu                  sync.Mutex
	sessions                  map[string]time.Time
	failures                  map[string]loginFailure
	token, username, password string
	caddyConfig               []byte
	children                  []*exec.Cmd
}

const sessionIdleTimeout = 30 * time.Minute

func (m *manager) reply(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func (m *manager) logged(r *http.Request) bool {
	c, e := r.Cookie("vh_session")
	if e != nil {
		return false
	}
	now := time.Now()
	m.mu.Lock()
	exp, ok := m.sessions[c.Value]
	if ok && now.Before(exp) {
		m.sessions[c.Value] = time.Now().Add(sessionIdleTimeout)
	} else if ok {
		delete(m.sessions, c.Value)
		ok = false
	}
	m.mu.Unlock()
	return ok
}
func (m *manager) require(w http.ResponseWriter, r *http.Request) bool {
	if m.logged(r) {
		return true
	}
	m.reply(w, 401, map[string]any{"ok": false, "error": "login required"})
	return false
}
func (m *manager) cleanupSessions() {
	now := time.Now()
	m.mu.Lock()
	for sid, exp := range m.sessions {
		if !now.Before(exp) {
			delete(m.sessions, sid)
		}
	}
	for key, f := range m.failures {
		if f.until.Before(now) {
			delete(m.failures, key)
		}
	}
	m.mu.Unlock()
}
func clientKey(r *http.Request) string {
	h := r.RemoteAddr
	if strings.HasPrefix(h, "127.0.0.1:") || strings.HasPrefix(h, "[::1]:") {
		if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
			h = strings.TrimSpace(strings.Split(forwarded, ",")[0])
		}
	}
	if i := strings.LastIndexByte(h, ':'); i >= 0 && strings.Count(h, ":") == 1 {
		h = h[:i]
	}
	return h
}
func (m *manager) loginAllowed(r *http.Request) bool {
	key := clientKey(r)
	m.mu.RLock()
	f := m.failures[key]
	m.mu.RUnlock()
	return !time.Now().Before(f.until)
}
func (m *manager) loginFailed(r *http.Request) {
	key := clientKey(r)
	m.mu.Lock()
	f := m.failures[key]
	f.count++
	if f.count >= 5 {
		f.count = 0
		f.until = time.Now().Add(5 * time.Minute)
	}
	m.failures[key] = f
	m.mu.Unlock()
}
func (m *manager) loginSucceeded(r *http.Request) {
	key := clientKey(r)
	m.mu.Lock()
	delete(m.failures, key)
	m.mu.Unlock()
}

func (m *manager) login(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		m.reply(w, 405, map[string]any{"ok": false})
		return
	}
	if !m.loginAllowed(r) {
		m.reply(w, 429, map[string]any{"ok": false, "error": "too many login attempts"})
		return
	}
	b, _ := io.ReadAll(io.LimitReader(r.Body, 65536))
	var x struct {
		Token    string `json:"token"`
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if json.Unmarshal(b, &x) != nil {
		m.reply(w, 400, map[string]any{"ok": false, "error": "invalid json"})
		return
	}
	tokenOK := m.token != "" && len(x.Token) == len(m.token) && subtle.ConstantTimeCompare([]byte(x.Token), []byte(m.token)) == 1
	userOK := len(x.Username) == len(m.username) && len(x.Password) == len(m.password) && subtle.ConstantTimeCompare([]byte(x.Username), []byte(m.username)) == 1 && subtle.ConstantTimeCompare([]byte(x.Password), []byte(m.password)) == 1
	if !tokenOK && !userOK {
		m.loginFailed(r)
		m.reply(w, 401, map[string]any{"ok": false, "error": "invalid credentials"})
		return
	}
	m.loginSucceeded(r)
	raw := make([]byte, 24)
	if _, e := rand.Read(raw); e != nil {
		m.reply(w, 500, map[string]any{"ok": false})
		return
	}
	sid := hex.EncodeToString(raw)
	m.mu.Lock()
	m.sessions[sid] = time.Now().Add(sessionIdleTimeout)
	m.mu.Unlock()
	secure := r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
	http.SetCookie(w, &http.Cookie{Name: "vh_session", Value: sid, Path: "/", HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode, MaxAge: 1800})
	m.reply(w, 200, map[string]any{"ok": true, "idle_timeout_seconds": 1800})
}
func (m *manager) logout(w http.ResponseWriter, r *http.Request) {
	if c, e := r.Cookie("vh_session"); e == nil {
		m.mu.Lock()
		delete(m.sessions, c.Value)
		m.mu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{Name: "vh_session", Value: "", Path: "/", HttpOnly: true, Secure: r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https"), SameSite: http.SameSiteLaxMode, MaxAge: -1})
	m.reply(w, 200, map[string]any{"ok": true})
}
func (m *manager) health(w http.ResponseWriter, r *http.Request) {
	m.reply(w, 200, map[string]any{"ok": true, "service": "go-manager", "time": time.Now().UTC()})
}

// sessionCheck is the loopback authority used by sibling services (media API) to
// verify a browser session. It also slides the idle timeout, so authenticated
// media traffic keeps the 30-minute window alive exactly like manager traffic.
func (m *manager) sessionCheck(w http.ResponseWriter, r *http.Request) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		m.reply(w, 403, map[string]any{"ok": false, "error": "loopback only"})
		return
	}
	if !m.logged(r) {
		m.reply(w, 401, map[string]any{"ok": false, "error": "login required"})
		return
	}
	m.reply(w, 200, map[string]any{"ok": true, "idle_timeout_seconds": int(sessionIdleTimeout.Seconds())})
}
func (m *manager) runtime(w http.ResponseWriter, r *http.Request) {
	if !m.require(w, r) {
		return
	}
	m.reply(w, 200, map[string]any{"ok": true, "pid": os.Getpid(), "go": "go-manager", "children": len(m.children)})
}

func (m *manager) caddyConfigHandler(w http.ResponseWriter, r *http.Request) {
	if !m.require(w, r) {
		return
	}
	m.configMu.Lock()
	defer m.configMu.Unlock()
	if r.Method == "GET" {
		m.mu.RLock()
		b := append([]byte(nil), m.caddyConfig...)
		m.mu.RUnlock()
		m.reply(w, 200, map[string]any{"ok": true, "caddyfile": string(b)})
		return
	}
	if r.Method != "POST" {
		m.reply(w, 405, map[string]any{"ok": false})
		return
	}
	b, _ := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	var x struct {
		Caddyfile string `json:"caddyfile"`
	}
	if json.Unmarshal(b, &x) != nil || !strings.Contains(x.Caddyfile, ":8088") {
		m.reply(w, 400, map[string]any{"ok": false, "error": "invalid caddyfile"})
		return
	}
	tmp := "/data/Caddyfile.go.tmp"
	if os.WriteFile(tmp, []byte(x.Caddyfile), 0644) != nil {
		m.reply(w, 500, map[string]any{"ok": false})
		return
	}
	if err := exec.Command("/usr/bin/caddy", "validate", "--config", tmp, "--adapter", "caddyfile").Run(); err != nil {
		os.Remove(tmp)
		m.reply(w, 400, map[string]any{"ok": false, "error": "validation failed"})
		return
	}
	old := append([]byte(nil), m.caddyConfig...)
	if err := os.WriteFile("/data/Caddyfile.go.old", old, 0644); err != nil {
		os.Remove(tmp)
		m.reply(w, 500, map[string]any{"ok": false})
		return
	}
	if err := os.Rename(tmp, "/data/Caddyfile"); err != nil {
		m.reply(w, 500, map[string]any{"ok": false})
		return
	}
	if err := exec.Command("/usr/bin/caddy", "reload", "--config", "/data/Caddyfile", "--adapter", "caddyfile").Run(); err != nil {
		restoreErr := os.WriteFile("/data/Caddyfile", old, 0644)
		reloadErr := error(nil)
		if restoreErr == nil {
			reloadErr = exec.Command("/usr/bin/caddy", "reload", "--config", "/data/Caddyfile", "--adapter", "caddyfile").Run()
		}
		if restoreErr != nil || reloadErr != nil {
			m.reply(w, 500, map[string]any{"ok": false, "error": "reload failed; rollback could not be verified"})
			return
		}
		m.reply(w, 500, map[string]any{"ok": false, "error": "reload failed; configuration rolled back"})
		return
	}
	m.mu.Lock()
	m.caddyConfig = []byte(x.Caddyfile)
	m.mu.Unlock()
	m.reply(w, 200, map[string]any{"ok": true})
}
func (m *manager) docker(w http.ResponseWriter, r *http.Request) {
	if !m.require(w, r) {
		return
	}
	host := r.URL.Query().Get("host")
	nas := os.Getenv("NAS_IP")
	if host != "127.0.0.1" && host != "localhost" && host != nas {
		m.reply(w, 400, map[string]any{"ok": false, "error": "remote scan requires authorized agent"})
		return
	}
	b, e := exec.Command("/usr/bin/curl", "-fsS", "--unix-socket", "/var/run/docker.sock", "http://localhost/containers/json?all=1").Output()
	if e != nil {
		m.reply(w, 500, map[string]any{"ok": false, "error": "docker unavailable"})
		return
	}
	var v any
	if json.Unmarshal(b, &v) != nil {
		m.reply(w, 502, map[string]any{"ok": false, "error": "invalid docker response"})
		return
	}
	m.reply(w, 200, map[string]any{"ok": true, "containers": v})
}
func routes(m *manager) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", m.health)
	mux.HandleFunc("/api/login", m.login)
	mux.HandleFunc("/api/logout", m.logout)
	mux.HandleFunc("/api/session/check", m.sessionCheck)
	mux.HandleFunc("/api/system/runtime", m.runtime)
	mux.HandleFunc("/api/admin/docker/scan", m.docker)
	mux.HandleFunc("/api/admin/caddyfile", m.caddyConfigHandler)
	mux.HandleFunc("/api/admin/caddy/config", m.caddyConfigHandler)
	return mux
}
func start(bin string, args ...string) *exec.Cmd {
	c := exec.Command(bin, args...)
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	if err := c.Start(); err != nil {
		log.Printf("start %s: %v", bin, err)
		return nil
	}
	return c
}
func validateCaddy(path string) error {
	out, err := exec.Command("/usr/bin/caddy", "validate", "--config", path, "--adapter", "caddyfile").CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// managerRoutes are the reverse-proxy blocks the Go manager must own. They are
// injected into legacy Caddyfiles that predate the Go manager.
var managerRoutes = []string{
	"handle /api/health",
	"handle /api/login",
	"handle /api/logout",
	"handle /api/system/runtime",
	"handle /api/admin/*",
}

// normalizeCaddyfile migrates an older Caddyfile in place. It is idempotent:
// only genuinely missing manager routes are inserted, so repeated container
// starts never accumulate duplicate handle blocks.
func normalizeCaddyfile(b []byte) []byte {
	s := strings.ReplaceAll(string(b), "\r\n", "\n")
	var missing []string
	for _, x := range managerRoutes {
		if !strings.Contains(s, x+" {") && !strings.Contains(s, x+"\t{") {
			missing = append(missing, x)
		}
	}
	if len(missing) == 0 {
		return []byte(s)
	}
	var sb strings.Builder
	sb.WriteString("\n")
	for _, x := range missing {
		sb.WriteString("\t" + x + " {\n\t\treverse_proxy http://127.0.0.1:9099\n\t}\n")
	}
	if i := strings.Index(s, "{"); i >= 0 {
		s = s[:i+1] + sb.String() + s[i+1:]
	}
	return []byte(s)
}
func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	if err := os.MkdirAll("/data", 0755); err != nil {
		log.Fatal(err)
	}
	b, _ := os.ReadFile("/data/Caddyfile")
	if len(b) == 0 {
		b, _ = os.ReadFile("/etc/caddy/Caddyfile")
	}
	b = normalizeCaddyfile(b)
	tmp := "/data/Caddyfile.startup.tmp"
	if err := os.WriteFile(tmp, b, 0644); err != nil {
		log.Fatal(err)
	}
	if err := validateCaddy(tmp); err != nil {
		_ = os.Remove(tmp)
		log.Fatalf("migrated Caddyfile validation failed: %v", err)
	}
	if err := os.Rename(tmp, "/data/Caddyfile"); err != nil {
		log.Fatal(err)
	}
	m := &manager{sessions: map[string]time.Time{}, failures: map[string]loginFailure{}, token: os.Getenv("ADMIN_TOKEN"), username: os.Getenv("ADMIN_USERNAME"), password: os.Getenv("ADMIN_PASSWORD"), caddyConfig: b}
	if m.username == "" {
		m.username = "ADMIN"
	}
	if m.password == "" {
		m.password = "ADMIN123"
	}
	for _, bin := range []string{"/usr/bin/media-api", "/usr/bin/subtitle-api"} {
		if c := start(bin); c != nil {
			m.children = append(m.children, c)
		}
	}
	if c := start("/usr/bin/caddy", "run", "--config", "/data/Caddyfile", "--adapter", "caddyfile"); c != nil {
		m.children = append(m.children, c)
	}
	addr := os.Getenv("MANAGER_ADDR")
	if addr == "" {
		addr = "127.0.0.1:9099"
	}
	srv := &http.Server{Addr: addr, Handler: routes(m), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		log.Printf("go-manager listening on %s", addr)
		if e := srv.ListenAndServe(); e != nil && e != http.ErrServerClosed {
			log.Printf("manager: %v", e)
		}
	}()
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	go func() {
		for range ticker.C {
			m.cleanupSessions()
		}
	}()
	<-ctx.Done()
	shutdown, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()
	_ = srv.Shutdown(shutdown)
	for _, c := range m.children {
		_ = c.Process.Signal(syscall.SIGTERM)
	}
	for _, c := range m.children {
		_, _ = c.Process.Wait()
	}
}
