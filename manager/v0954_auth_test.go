package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// v0.9.56 鉴权模式与账户持久化单测（v0.9.58 更新契约）：
//  1. 环境变量推导：ADMIN_PASSWORD 为空 → 一次性随机密码 + must_change（不再是 open）；非空 → password（hash 可验）。
//  2. auth.json 读写往返（含 must_change）+ 文件优先于环境变量。
//  3. 密码校验（常数时间比较路径）与错误密码拒绝。
//  4. 增强密码校验 validatePassword（v0.9.58）：长度/字母数字/弱口令黑名单/含用户名。
//  5. 随机密码生成器（长度/字符集/两次不重复）。
//  6. 受限会话（must_change）只放行改密等白名单路径（v0.9.58）。
func TestV0958DeriveStoredAuthRandomWhenNoPassword(t *testing.T) {
	s, err := deriveStoredAuth("", "")
	if err != nil {
		t.Fatal(err)
	}
	if s.Mode != "password" {
		t.Fatalf("v0.9.58: empty ADMIN_PASSWORD must yield password mode with a random password, got %q", s.Mode)
	}
	if s.Username != "ADMIN" {
		t.Fatalf("default username should be ADMIN, got %q", s.Username)
	}
	if !s.MustChange {
		t.Fatal("empty ADMIN_PASSWORD must mark must_change=true")
	}
	if len(s.Hash) != 64 || len(s.Salt) < 16 {
		t.Fatalf("random password must produce a valid credential (salt=%d hash=%d)", len(s.Salt), len(s.Hash))
	}
	s2, err := deriveStoredAuth("admin", "")
	if err != nil {
		t.Fatal(err)
	}
	if s2.Username != "admin" || s2.Mode != "password" || !s2.MustChange {
		t.Fatalf("v0.9.58 empty-password record must keep username + must_change, got %+v", s2)
	}
}

func TestV0954DeriveStoredAuthPasswordHashes(t *testing.T) {
	s, err := deriveStoredAuth("ADMIN", "s3cret-!pw")
	if err != nil {
		t.Fatal(err)
	}
	if s.Mode != "password" {
		t.Fatalf("non-empty password must yield password mode, got %q", s.Mode)
	}
	if len(s.Salt) < 16 || len(s.Hash) != 64 {
		t.Fatalf("salt/hash malformed: salt=%d hash=%d", len(s.Salt), len(s.Hash))
	}
	m := &manager{username: s.Username, salt: s.Salt, hash: s.Hash}
	if !m.passwordOK("s3cret-!pw") {
		t.Fatal("correct password must verify")
	}
	if m.passwordOK("wrong") {
		t.Fatal("wrong password must not verify")
	}
	if m.passwordOK("") {
		t.Fatal("empty password must not verify")
	}
}

func TestV0954AuthFileRoundTrip(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "auth.json")
	m := &manager{}
	if m.loadAuthFile(file) {
		t.Fatal("missing auth file must not load")
	}
	m.authFile = file
	m.open = false
	m.username = "newbie"
	m.salt = "0123456789abcdef0123456789abcdef"
	m.hash = sha256Hex(m.salt + "\x00" + "hello123")
	if err := m.saveAuthFile(); err != nil {
		t.Fatalf("save: %v", err)
	}
	st, err := os.Stat(file)
	if err != nil {
		t.Fatalf("auth file missing after save: %v", err)
	}
	if st.Mode().Perm() != 0600 {
		t.Fatalf("auth file must be 0600, got %v", st.Mode().Perm())
	}
	m2 := &manager{}
	if !m2.loadAuthFile(file) {
		t.Fatal("saved auth file must load")
	}
	if m2.username != "newbie" || m2.open || m2.hash != m.hash {
		t.Fatalf("round trip mismatch: %+v vs %+v", m2, m)
	}
	if !m2.passwordOK("hello123") {
		t.Fatal("round-tripped credentials must verify")
	}
	// open mode round trip: v0.9.56 保留 hash（切回密码模式/改密时验证原密码）
	m3 := &manager{authFile: file}
	m3.username = "newbie"
	m3.open = true
	m3.salt = "0123456789abcdef0123456789abcdef"
	m3.hash = sha256Hex(m3.salt + "\x00" + "hello123")
	if err := m3.saveAuthFile(); err != nil {
		t.Fatalf("save open: %v", err)
	}
	m4 := &manager{}
	if !m4.loadAuthFile(file) || !m4.open || m4.hash != m3.hash {
		t.Fatalf("open mode round trip failed: %+v", m4)
	}
	if !m4.passwordOK("hello123") {
		t.Fatal("open mode with retained hash must verify the original password")
	}
	if m4.passwordOK("nope") {
		t.Fatal("open mode retained hash must reject wrong password")
	}
}

func TestV0955OpenModeWithoutHashCannotVerify(t *testing.T) {
	m := &manager{open: true, username: "ADMIN", salt: "", hash: ""}
	if m.passwordOK("anything") {
		t.Fatal("pure open mode (never set a password) must not verify any password")
	}
}

func TestV0954LoadAuthFileRejectsGarbage(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "auth.json")
	os.WriteFile(file, []byte(`{"mode":"password","username":"a"}`), 0600) // missing hash
	m := &manager{}
	if m.loadAuthFile(file) {
		t.Fatal("password mode without hash must be rejected")
	}
	os.WriteFile(file, []byte(`{"mode":"weird","username":"a","salt":"12345678","hash":"x"}`), 0600)
	if m.loadAuthFile(file) {
		t.Fatal("unknown mode must be rejected")
	}
	os.WriteFile(file, []byte(`{not json`), 0600)
	if m.loadAuthFile(file) {
		t.Fatal("broken json must be rejected")
	}
}

// 防回归：新 manager 路由确实写进注入清单（legacy Caddyfile 会自动补 handle）。
func TestV0954ManagerRoutesIncludeAuth(t *testing.T) {
	joined := strings.Join(managerRoutes, "\n")
	if !strings.Contains(joined, "/api/auth/mode") || !strings.Contains(joined, "/api/account") {
		t.Fatalf("managerRoutes missing auth endpoints:\n%s", joined)
	}
}

// v0.9.58：随机密码生成器 —— 长度固定、无歧义字符集、两次生成不重复。
func TestV0958GenerateRandomPassword(t *testing.T) {
	const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
	p1, err := generateRandomPassword()
	if err != nil {
		t.Fatal(err)
	}
	p2, err := generateRandomPassword()
	if err != nil {
		t.Fatal(err)
	}
	if len(p1) != 16 || len(p2) != 16 {
		t.Fatalf("random password must be 16 chars, got %d/%d", len(p1), len(p2))
	}
	for _, r := range p1 {
		if !strings.ContainsRune(alphabet, r) {
			t.Fatalf("random password contains disallowed char %q", r)
		}
	}
	if p1 == p2 {
		t.Fatal("two generated passwords must not collide")
	}
}

// v0.9.58：增强密码校验 —— 长度/字母数字组合/弱口令黑名单/包含用户名。
func TestV0958ValidatePassword(t *testing.T) {
	cases := []struct {
		pw, user, want string
	}{
		{"short7!", "", "密码至少 8 位"},
		{"abcdefgh", "", "密码需同时包含字母和数字"},
		{"12345678", "", "密码需同时包含字母和数字"},
		{"admin123", "", "密码过于常见，请更换更复杂的密码"},
		{"ADMIN123", "", "密码过于常见，请更换更复杂的密码"},
		{"password1", "", "密码过于常见，请更换更复杂的密码"},
		{"myAdminXxx1", "admin", "密码不能包含用户名"},
		{"A1b2c3d4", "", ""}, // 合法
		{"S3cretPass9", "", ""},
	}
	for _, c := range cases {
		if got := validatePassword(c.pw, c.user); got != c.want {
			t.Fatalf("validatePassword(%q,%q) = %q, want %q", c.pw, c.user, got, c.want)
		}
	}
}

// v0.9.58：must_change 持久化往返 —— 首次启动写入，容器重建后读回，不再重新生成。
func TestV0958AuthFileMustChangeRoundTrip(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "auth.json")
	m := &manager{authFile: file, username: "ADMIN", open: false,
		salt: "0123456789abcdef0123456789abcdef", hash: sha256Hex("0123456789abcdef0123456789abcdef\x00onetime-pw"), mustChange: true}
	if err := m.saveAuthFile(); err != nil {
		t.Fatalf("save: %v", err)
	}
	m2 := &manager{}
	if !m2.loadAuthFile(file) {
		t.Fatal("saved auth file must load")
	}
	if !m2.mustChange {
		t.Fatal("must_change must survive round trip")
	}
	if m2.open {
		t.Fatal("must_change record must be password mode")
	}
	// 改密后清除 must_change 再持久化
	m2.mustChange = false
	if err := m2.saveAuthFile(); err != nil {
		t.Fatalf("save cleared: %v", err)
	}
	m3 := &manager{}
	if !m3.loadAuthFile(file) || m3.mustChange {
		t.Fatal("cleared must_change must persist")
	}
}

// v0.9.58：受限会话（强制改密）白名单 —— 只有改密/鉴权模式/登出/会话探测放行。
func TestV0958RestrictedSessionAllowlist(t *testing.T) {
	allowed := []string{"/api/account", "/api/auth/mode", "/api/logout", "/api/system/runtime", "/api/health"}
	for _, p := range allowed {
		if !restrictedAllowed(p) {
			t.Fatalf("restricted session must allow %s", p)
		}
	}
	blocked := []string{"/api/admin/caddyfile", "/api/admin/docker/scan", "/api/session/check", "/api/whatever"}
	for _, p := range blocked {
		if restrictedAllowed(p) {
			t.Fatalf("restricted session must NOT allow %s", p)
		}
	}
}

func TestV0958RejectsLegacyAdmin123AsBootstrap(t *testing.T) {
	s, err := deriveStoredAuth("ADMIN", "AdMiN123")
	if err != nil {
		t.Fatal(err)
	}
	if !s.MustChange || s.Hash == sha256Hex(s.Salt+"\x00"+"AdMiN123") {
		t.Fatal("legacy admin123 must be replaced by a random bootstrap credential")
	}
}

// 第一次成功登录必须原子消费初始密码；同一密码第二次登录立即失败，但第一次登录
// 得到的受限会话仍可提交新密码。
func TestV0958BootstrapPasswordIsConsumedOnFirstLogin(t *testing.T) {
	dir := t.TempDir()
	salt := "0123456789abcdef0123456789abcdef"
	m := &manager{
		sessions: map[string]sessionEntry{}, failures: map[string]loginFailure{},
		username: "ADMIN", salt: salt, hash: sha256Hex(salt + "\x00" + "Bootstrap9X"),
		mustChange: true, authFile: filepath.Join(dir, "auth.json"),
	}
	if err := m.saveAuthFile(); err != nil {
		t.Fatal(err)
	}
	h := routes(m)
	loginBody, _ := json.Marshal(map[string]string{"username": "ADMIN", "password": "Bootstrap9X"})
	first := httptest.NewRecorder()
	h.ServeHTTP(first, httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(loginBody)))
	if first.Code != http.StatusOK {
		t.Fatalf("first login = %d: %s", first.Code, first.Body.String())
	}
	var sessionCookie *http.Cookie
	for _, c := range first.Result().Cookies() {
		if c.Name == "vh_session" {
			sessionCookie = c
		}
	}
	if sessionCookie == nil {
		t.Fatal("first login did not issue session cookie")
	}
	second := httptest.NewRecorder()
	h.ServeHTTP(second, httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(loginBody)))
	if second.Code != http.StatusUnauthorized {
		t.Fatalf("second login = %d, want 401", second.Code)
	}
	// 已消费状态写入磁盘后，即使服务重启也不能再次使用初始密码登录。
	restarted := &manager{sessions: map[string]sessionEntry{}, failures: map[string]loginFailure{}}
	if !restarted.loadAuthFile(m.authFile) || !restarted.bootstrapConsumed {
		t.Fatal("consumed bootstrap state must load after restart")
	}
	restartLogin := httptest.NewRecorder()
	routes(restarted).ServeHTTP(restartLogin, httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(loginBody)))
	if restartLogin.Code != http.StatusUnauthorized {
		t.Fatalf("bootstrap login after restart = %d, want 401", restartLogin.Code)
	}

	accountBody, _ := json.Marshal(map[string]string{"old_password": "Bootstrap9X", "username": "ADMIN", "password": "SecurePass9X", "mode": "password"})
	req := httptest.NewRequest(http.MethodPost, "/api/account", bytes.NewReader(accountBody))
	req.AddCookie(sessionCookie)
	changed := httptest.NewRecorder()
	h.ServeHTTP(changed, req)
	if changed.Code != http.StatusOK {
		t.Fatalf("forced password change = %d: %s", changed.Code, changed.Body.String())
	}
	if m.mustChange || m.bootstrapConsumed || !m.passwordOK("SecurePass9X") || m.passwordOK("Bootstrap9X") {
		t.Fatal("password change must clear bootstrap state and invalidate old password")
	}
	m2 := &manager{}
	if !m2.loadAuthFile(m.authFile) || m2.mustChange || m2.bootstrapConsumed || !m2.passwordOK("SecurePass9X") {
		t.Fatal("completed bootstrap state must persist")
	}
}
