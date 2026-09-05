package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
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
	"path/filepath"
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
	mu                 sync.RWMutex
	configMu           sync.Mutex
	sessions           map[string]time.Time
	failures           map[string]loginFailure
	username           string
	open               bool          // v0.9.56 开放模式（无密码）：true 时不校验登录
	salt, hash         string        // 凭据哈希（sha256(salt+password)），auth.json 持久化
	authFile           string        // /data/auth.json：账户与鉴权模式的持久化文件
	caddyConfig        []byte
	children           []*exec.Cmd
}

const sessionIdleTimeout = 30 * time.Minute

/* ---------- v0.9.56 鉴权模式与账户持久化 ---------- */

// storedAuth 是 /data/auth.json 的磁盘形态。模式说明：
//   - mode=password（默认）：必须登录；username/salt/hash 用于校验。
//   - mode=open：开放模式（免登录进入）；v0.9.56 起**保留** salt/hash 凭据，
//     以便从开放模式切回密码模式/修改密码时仍能验证原密码。
// 持久化文件优先于环境变量（ADMIN_USERNAME/ADMIN_PASSWORD）；文件不存在时
// 按环境变量推导 —— ADMIN_PASSWORD 为空则直接进入开放模式。
type storedAuth struct {
	Mode     string `json:"mode,omitempty"` // "password" | "open"
	Username string `json:"username"`
	Salt     string `json:"salt,omitempty"`
	Hash     string `json:"hash,omitempty"`
	Updated  int64  `json:"updated,omitempty"`
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func newAuthSalt() string {
	raw := make([]byte, 16)
	if _, e := rand.Read(raw); e != nil {
		return sha256Hex(fmt.Sprintf("%d", time.Now().UnixNano()))[:32]
	}
	return hex.EncodeToString(raw)
}

// deriveStoredAuth 把环境变量凭据整理成 storedAuth：ADMIN_PASSWORD 为空时
// 表示“不设置登录密码”→ 开放模式。
func deriveStoredAuth(usernameEnv, passwordEnv string) storedAuth {
	u := strings.TrimSpace(usernameEnv)
	if u == "" {
		u = "ADMIN"
	}
	pw := passwordEnv
	if pw == "" {
		return storedAuth{Mode: "open", Username: u}
	}
	salt := newAuthSalt()
	return storedAuth{Mode: "password", Username: u, Salt: salt, Hash: sha256Hex(salt + "\x00" + pw)}
}

// loadAuthFile 读取持久化账户文件；文件不存在或解析失败返回 false（保持现状）。
func (m *manager) loadAuthFile(file string) bool {
	b, e := os.ReadFile(file)
	if e != nil {
		return false
	}
	var s storedAuth
	if json.Unmarshal(b, &s) != nil {
		return false
	}
	u := strings.TrimSpace(s.Username)
	if u == "" || (s.Mode != "password" && s.Mode != "open") {
		return false
	}
	if s.Mode == "password" && (s.Hash == "" || len(s.Salt) < 8) {
		return false
	}
	m.authFile = file
	m.username = u
	// v0.9.56：开放模式也保留 salt/hash（切回密码模式/改密时验证原密码用）。
	m.salt, m.hash = s.Salt, s.Hash
	m.open = s.Mode == "open"
	return true
}

// saveAuthFile 原子写 /data/auth.json（0600）。开放模式同样落 salt/hash 凭据，
// 保证切回密码模式时必须先通过原密码验证。
func (m *manager) saveAuthFile() error {
	if m.authFile == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(m.authFile), 0755); err != nil {
		return err
	}
	s := storedAuth{Username: m.username, Updated: time.Now().Unix()}
	if m.open {
		s.Mode = "open"
	} else {
		s.Mode = "password"
	}
	s.Salt, s.Hash = m.salt, m.hash
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(m.authFile), ".auth-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err = tmp.Chmod(0600); err == nil {
		_, err = tmp.Write(b)
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(tmpName, m.authFile)
}

// passwordOK 常数时间校验明文密码。v0.9.56：开放模式若保留了 hash（曾设置过密码）
// 同样参与校验 —— 从开放模式切回密码模式/修改密码必须验证原密码；从未设置过
// 密码的纯开放模式 hash 为空，恒 false（此时无凭据可校验，允许直接设置新密码）。
func (m *manager) passwordOK(pw string) bool {
	if m.hash == "" {
		return false
	}
	want := sha256Hex(m.salt + "\x00" + pw)
	return len(want) == len(m.hash) && subtle.ConstantTimeCompare([]byte(want), []byte(m.hash)) == 1
}

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
	// v0.9.56 开放模式：无密码屏障，所有管理端点直接放行。
	if m.open {
		return true
	}
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
	// 开放模式不做登录限流（自动登录也不应触发 429）。
	if m.open {
		return true
	}
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
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if json.Unmarshal(b, &x) != nil {
		m.reply(w, 400, map[string]any{"ok": false, "error": "invalid json"})
		return
	}
	userOK := m.open // 开放模式：任意凭据（含空）都放行，只为下发会话 Cookie
	if !m.open {
		userOK = len(x.Username) == len(m.username) && subtle.ConstantTimeCompare([]byte(x.Username), []byte(m.username)) == 1 && m.passwordOK(x.Password)
	}
	if !userOK {
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
func (m *manager) authMode(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		m.reply(w, 405, map[string]any{"ok": false})
		return
	}
	// 公共端点：登录遮罩/启动探测需要知道当前鉴权模式（开放模式直接自动登录）。
	// v0.9.56：同时暴露 has_password —— 开放模式曾设置过密码时，账户变更仍需验证。
	m.mu.RLock()
	open, user, hashed := m.open, m.username, m.hash != ""
	m.mu.RUnlock()
	mode := "password"
	if open {
		mode = "open"
	}
	m.reply(w, 200, map[string]any{"ok": true, "mode": mode, "username": user, "has_password": hashed})
}

// account 修改登录用户名 / 登录密码 / 鉴权模式（v0.9.56+）。需要有效会话。
// v0.9.56 安全修正：只要系统存在密码凭据（hash 非空，无论当前是密码模式还是
// 开放模式），任何账户变更（改用户名/改密码/切换模式）都必须验证原密码；
// 从未设置过密码的纯开放模式（hash 为空）才允许直接设置新密码。
func (m *manager) account(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		m.reply(w, 405, map[string]any{"ok": false})
		return
	}
	if !m.require(w, r) {
		return
	}
	b, _ := io.ReadAll(io.LimitReader(r.Body, 65536))
	var x struct {
		OldPassword string `json:"old_password"`
		Username    string `json:"username"`
		Password    string `json:"password"`
		Mode        string `json:"mode"` // "password" | "open"
	}
	if json.Unmarshal(b, &x) != nil {
		m.reply(w, 400, map[string]any{"ok": false, "error": "invalid json"})
		return
	}
	if x.Mode != "" && x.Mode != "password" && x.Mode != "open" {
		m.reply(w, 400, map[string]any{"ok": false, "error": "invalid auth mode"})
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	curOpen := m.open
	newUser := strings.TrimSpace(x.Username)
	if newUser == "" {
		newUser = m.username
	}
	if len(newUser) > 64 || strings.ContainsAny(newUser, "/\\\n\r") {
		m.reply(w, 400, map[string]any{"ok": false, "error": "用户名不合法"})
		return
	}
	wantOpen := curOpen
	if x.Mode == "open" {
		wantOpen = true
	}
	if x.Mode == "password" {
		wantOpen = false
	}
	if x.Password != "" {
		wantOpen = false // 设置了新密码 = 密码模式
	}
	// v0.9.56 凭据校验：存在密码凭据时（曾设置过密码），任何变更必须验证原密码。
	// 纯开放模式（从未设置密码，hash 为空）首次设置密码不需要旧密码。
	if m.hash != "" && !m.passwordOK(x.OldPassword) {
		m.reply(w, 403, map[string]any{"ok": false, "error": "当前密码不正确"})
		return
	}
	if wantOpen {
		// 开放模式（免登录进入）：v0.9.56 保留 salt/hash 凭据，
		// 切回密码模式/修改密码时仍需原密码验证，防止开放模式成为无验证改密的通道。
		m.open = true
		m.username = newUser
		if err := m.saveAuthFile(); err != nil {
			m.reply(w, 500, map[string]any{"ok": false, "error": "持久化失败：" + err.Error()})
			return
		}
		m.dropOtherSessions(r)
		m.reply(w, 200, map[string]any{"ok": true, "mode": "open", "username": m.username, "message": "已切换为开放模式（无密码），任何人无需登录即可进入"})
		return
	}
	// 密码模式：开放模式切换回来必须设置新密码（纯开放模式无凭据可沿用）。
	if curOpen && m.hash == "" && x.Password == "" {
		m.reply(w, 400, map[string]any{"ok": false, "error": "请设置新登录密码"})
		return
	}
	if x.Password != "" {
		if len(x.Password) < 6 {
			m.reply(w, 400, map[string]any{"ok": false, "error": "密码至少 6 位"})
			return
		}
		if strings.EqualFold(x.Password, newUser) {
			m.reply(w, 400, map[string]any{"ok": false, "error": "密码不能与用户名相同"})
			return
		}
		m.salt = newAuthSalt()
		m.hash = sha256Hex(m.salt + "\x00" + x.Password)
	}
	m.open = false
	m.username = newUser
	if err := m.saveAuthFile(); err != nil {
		m.reply(w, 500, map[string]any{"ok": false, "error": "持久化失败：" + err.Error()})
		return
	}
	m.dropOtherSessions(r)
	m.reply(w, 200, map[string]any{"ok": true, "mode": "password", "username": m.username, "message": "账户信息已保存"})
}

// dropOtherSessions 凭据变更后使其它会话失效（保留当前请求的会话）。
func (m *manager) dropOtherSessions(r *http.Request) {
	current := ""
	if c, e := r.Cookie("vh_session"); e == nil {
		current = c.Value
	}
	for sid := range m.sessions {
		if sid != current {
			delete(m.sessions, sid)
		}
	}
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
	// v0.9.56 开放模式：媒体写操作等依赖本回环会话校验的调用全部放行。
	if m.open {
		m.reply(w, 200, map[string]any{"ok": true, "mode": "open", "idle_timeout_seconds": int(sessionIdleTimeout.Seconds())})
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
	mux.HandleFunc("/api/auth/mode", m.authMode)
	mux.HandleFunc("/api/account", m.account)
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

// caddyPath is the caddy binary used for validation. It is a variable so tests
// can point at the repo-local binary; production always uses the image path.
var caddyPath = "/usr/bin/caddy"

func validateCaddy(path string) error {
	out, err := exec.Command(caddyPath, "validate", "--config", path, "--adapter", "caddyfile").CombinedOutput()
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
	"handle /api/auth/mode",
	"handle /api/account",
	"handle /api/system/runtime",
	"handle /api/admin/*",
}

// cachePolicyMarker identifies the v0.8.6 static-asset cache policy. The
// container prefers the persisted /data/Caddyfile over the image's
// /etc/caddy/Caddyfile, so pulling a new image alone would NOT deliver new
// cache headers to existing installs — the browser would keep executing the
// stale JS bundle this release exists to fix. Startup therefore migrates the
// policy into place, keyed on this marker so it happens exactly once and any
// operator edits inside the block are preserved.
const cachePolicyMarker = "VAULTHUB-CACHE-POLICY"

// cachePolicyBody is inserted verbatim (indented to match the surrounding
// block) right after the static `root *` directive, i.e. before try_files and
// file_server so the header matchers take effect.
var cachePolicyBody = []string{
	"# " + cachePolicyMarker + " v1",
	"# /web/ 资源由嵌套 handle 独占：缺失文件返回 404，不会回落成 index.html。",
	"# 带 ?v=<语义版本> 且文件存在 → immutable 长缓存；其余一律短缓存回源。",
	"handle /web/* {",
	"	@versioned_asset {",
	"		file",
	"		expression `{query.v}.matches(\"^[0-9]+\\\\.[0-9]+\\\\.[0-9]+$\")`",
	"	}",
	"	header @versioned_asset Cache-Control \"public, max-age=31536000, immutable\"",
	"",
	"	@unversioned_asset not expression `{query.v}.matches(\"^[0-9]+\\\\.[0-9]+\\\\.[0-9]+$\")`",
	"	header @unversioned_asset Cache-Control \"public, max-age=300, must-revalidate\"",
	"",
	"	@web_miss not file",
	"	header @web_miss Cache-Control \"no-store\"",
	"",
	"	file_server",
	"}",
	"",
	"# 入口页是版本入口，必须每次回源，否则升级后仍会执行缓存里的旧脚本。",
	"handle {",
	"	header Cache-Control \"no-store, must-revalidate\"",
	"	try_files {path} /index.html",
	"	file_server",
	"}",
	"# " + cachePolicyMarker + "-END",
}

// injectCachePolicy adds the static-asset cache policy to a Caddyfile that does
// not have it yet. It is a no-op when the marker is already present (fresh
// images ship it, and operators may have customised it), when the file already
// defines any of the policy's matcher names (re-defining a matcher makes Caddy
// reject the whole config and the container would restart forever), and when no
// static `root *` directive exists to anchor the insertion.
func injectCachePolicy(s string) string {
	if strings.Contains(s, cachePolicyMarker) {
		return s
	}
	for _, name := range []string{"@versioned_asset", "@unversioned_asset", "@web_miss"} {
		if strings.Contains(s, name) {
			return s
		}
	}
	lines := strings.Split(s, "\n")
	anchor := -1
	for i, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "root *") {
			anchor = i
			break
		}
	}
	if anchor < 0 {
		return s
	}
	indent := lines[anchor][:len(lines[anchor])-len(strings.TrimLeft(lines[anchor], " 	"))]

	// Drop the legacy `try_files` / `file_server` pair that used to live directly
	// in this block: the injected policy owns serving now, and leaving the old
	// directives behind would re-introduce the SPA fallback for /web/* (a missing
	// asset would answer 200 text/html again, which is the bug being fixed).
	body := make([]string, 0, len(lines)-anchor)
	for _, line := range lines[anchor+1:] {
		trimmed := strings.TrimSpace(line)
		if trimmed == "try_files {path} /index.html" || trimmed == "file_server" {
			// Only strip while still inside the static block (deeper indent).
			if strings.HasPrefix(line, indent) {
				continue
			}
		}
		body = append(body, line)
	}

	block := make([]string, 0, len(cachePolicyBody)+2)
	block = append(block, "")
	for _, line := range cachePolicyBody {
		if line == "" {
			block = append(block, "")
			continue
		}
		block = append(block, indent+line)
	}
	out := make([]string, 0, len(lines)+len(block))
	out = append(out, lines[:anchor+1]...)
	out = append(out, block...)
	out = append(out, body...)
	return strings.Join(out, "\n")
}

// normalizeCaddyfile migrates an older Caddyfile in place. It is idempotent:
// only genuinely missing manager routes are inserted, so repeated container
// starts never accumulate duplicate handle blocks.
func normalizeCaddyfile(b []byte) []byte {
	s := strings.ReplaceAll(string(b), "\r\n", "\n")
	s = injectCachePolicy(s)
	var missing []string
	for _, x := range managerRoutes {
		if !strings.Contains(s, x+" {") && !strings.Contains(s, x+"	{") {
			missing = append(missing, x)
		}
	}
	if len(missing) == 0 {
		return []byte(s)
	}
	var sb strings.Builder
	sb.WriteString("\n")
	for _, x := range missing {
		sb.WriteString("	" + x + " {\n		reverse_proxy http://127.0.0.1:9099\n	}\n")
	}
	if i := strings.Index(s, "{"); i >= 0 {
		s = s[:i+1] + sb.String() + s[i+1:]
	}
	return []byte(s)
}

// prepareCaddyfile resolves the effective Caddyfile at startup: prefer the
// persisted /data copy, fall back to the image default, and inject the cache
// policy. A persisted file that no longer parses must not be fatal — with
// restart: unless-stopped that means an endless crash loop and a permanently
// unreachable WebUI, so the user cannot even open the Caddy editor to fix it.
// The broken file is preserved next to it for inspection.
func prepareCaddyfile(dataPath, builtinPath, tmpPath string) ([]byte, error) {
	b, _ := os.ReadFile(dataPath)
	usedPersisted := len(b) > 0
	if !usedPersisted {
		b, _ = os.ReadFile(builtinPath)
	}
	b = normalizeCaddyfile(b)
	if err := os.WriteFile(tmpPath, b, 0644); err != nil {
		return nil, err
	}
	err := validateCaddy(tmpPath)
	if err == nil {
		return b, nil
	}
	_ = os.Remove(tmpPath)
	if !usedPersisted {
		return nil, fmt.Errorf("built-in Caddyfile validation failed: %w", err)
	}
	log.Printf("persisted %s is invalid (%v); falling back to the built-in config", dataPath, err)
	if e := os.Rename(dataPath, dataPath+".invalid"); e != nil {
		log.Printf("could not preserve the invalid Caddyfile: %v", e)
	} else {
		log.Printf("the invalid file was kept as %s.invalid", dataPath)
	}
	fallback, e := os.ReadFile(builtinPath)
	if e != nil {
		return nil, fmt.Errorf("built-in Caddyfile is unreadable: %w", e)
	}
	b = normalizeCaddyfile(fallback)
	if e := os.WriteFile(tmpPath, b, 0644); e != nil {
		return nil, e
	}
	if e := validateCaddy(tmpPath); e != nil {
		_ = os.Remove(tmpPath)
		return nil, fmt.Errorf("built-in Caddyfile validation failed: %w", e)
	}
	return b, nil
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	if err := os.MkdirAll("/data", 0755); err != nil {
		log.Fatal(err)
	}
	tmp := "/data/Caddyfile.startup.tmp"
	b, err := prepareCaddyfile("/data/Caddyfile", "/etc/caddy/Caddyfile", tmp)
	if err != nil {
		log.Fatal(err)
	}
	if err := os.Rename(tmp, "/data/Caddyfile"); err != nil {
		log.Fatal(err)
	}
	m := &manager{sessions: map[string]time.Time{}, failures: map[string]loginFailure{}, caddyConfig: b}
	// v0.9.56：鉴权持久化文件优先；文件缺失时按环境变量推导
	// （ADMIN_PASSWORD 为空 → 开放模式）。首次通过系统设置保存账户后才生成 auth.json。
	authFile := os.Getenv("MANAGER_AUTH_FILE")
	if authFile == "" {
		authFile = "/data/auth.json"
	}
	if !m.loadAuthFile(authFile) {
		s := deriveStoredAuth(os.Getenv("ADMIN_USERNAME"), os.Getenv("ADMIN_PASSWORD"))
		m.authFile = authFile
		m.username = s.Username
		m.salt, m.hash = s.Salt, s.Hash
		m.open = s.Mode == "open"
		if m.open {
			log.Printf("v0.9.56: no login password configured -> running in OPEN mode (no password). " +
				"Log in via another instance to change it in 系统设置 → 账户与登录, or set ADMIN_PASSWORD.")
		}
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
