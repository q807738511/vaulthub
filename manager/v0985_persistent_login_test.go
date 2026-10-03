package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// v0.9.85 持续登录单测：
//  1. 保持天数规整：只接受 30（默认）与 60（勾选）；越界一律回落默认档。
//  2. TTL 换算：默认 30 天、勾选 60 天，旧记录 days=0 按默认档。
//  3. 登录签发的 vh_session 必须是持久 cookie（MaxAge = 30/60 天）并回显 session_days。
//  4. 会话表落盘 + 重启后恢复（容器重建仍保持登录）。
//  5. 退出登录 / 凭据变更后，持久化文件里不再保留该会话（防止"复活"）。
//  6. 滑动续期按会话自身天数，30 分钟后不会过期掉。
func TestV0985SessionDaysNormalised(t *testing.T) {
	cases := []struct {
		in   int
		want int
	}{
		{0, sessionDefaultDays},
		{1, sessionDefaultDays},
		{29, sessionDefaultDays},
		{30, sessionDefaultDays},
		{31, sessionDefaultDays},
		{59, sessionDefaultDays},
		{60, sessionLongDays},
		{365, sessionLongDays},
		{-7, sessionDefaultDays},
	}
	for _, c := range cases {
		if got := sessionDaysFor(c.in); got != c.want {
			t.Fatalf("sessionDaysFor(%d) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestV0985SessionTTL(t *testing.T) {
	if got := sessionTTLFor(0); got != 30*24*time.Hour {
		t.Fatalf("default ttl = %v, want 30d", got)
	}
	if got := sessionTTLFor(sessionDefaultDays); got != 30*24*time.Hour {
		t.Fatalf("30d ttl = %v", got)
	}
	if got := sessionTTLFor(sessionLongDays); got != 60*24*time.Hour {
		t.Fatalf("60d ttl = %v", got)
	}
	if got := sessionTTLFor(3); got != 30*24*time.Hour {
		t.Fatalf("legacy short ttl must not shrink below default, got %v", got)
	}
}

// newAuthManager 造一个可用密码登录的 manager（salt/hash 用真实派生结果）。
func newAuthManager(t *testing.T, sessionsFile string) *manager {
	t.Helper()
	s, err := deriveStoredAuth("ADMIN", "Test12345")
	if err != nil {
		t.Fatal(err)
	}
	return &manager{
		sessions:     map[string]sessionEntry{},
		failures:     map[string]loginFailure{},
		username:     s.Username,
		salt:         s.Salt,
		hash:         s.Hash,
		authFile:     filepath.Join(filepath.Dir(sessionsFile), "auth.json"),
		sessionsFile: sessionsFile,
	}
}

func loginRequest(t *testing.T, m *manager, body string) (*httptest.ResponseRecorder, http.Cookie) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(body))
	req.RemoteAddr = "192.168.112.9:41234"
	rec := httptest.NewRecorder()
	m.login(rec, req)
	if rec.Code != 200 {
		t.Fatalf("login status = %d body=%s", rec.Code, rec.Body.String())
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == "vh_session" {
			return rec, *c
		}
	}
	t.Fatalf("no vh_session cookie in %+v", rec.Result().Cookies())
	return rec, http.Cookie{}
}

func TestV0985LoginCookieIsPersistent(t *testing.T) {
	dir := t.TempDir()
	m := newAuthManager(t, filepath.Join(dir, "sessions.json"))

	rec, cookie := loginRequest(t, m, `{"username":"ADMIN","password":"Test12345"}`)
	if cookie.MaxAge != int((30 * 24 * time.Hour).Seconds()) {
		t.Fatalf("default cookie MaxAge = %d, want 30d", cookie.MaxAge)
	}
	if cookie.Expires.IsZero() {
		t.Fatal("persistent cookie must carry Expires for older browsers")
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if int(body["session_days"].(float64)) != sessionDefaultDays {
		t.Fatalf("session_days = %v, want 30", body["session_days"])
	}
	if int(body["idle_timeout_seconds"].(float64)) != int((30 * 24 * time.Hour).Seconds()) {
		t.Fatalf("idle_timeout_seconds = %v, want 30d", body["idle_timeout_seconds"])
	}

	rec, cookie = loginRequest(t, m, `{"username":"ADMIN","password":"Test12345","keep_days":60}`)
	if cookie.MaxAge != int((60 * 24 * time.Hour).Seconds()) {
		t.Fatalf("keep_days=60 cookie MaxAge = %d, want 60d", cookie.MaxAge)
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if int(body["session_days"].(float64)) != sessionLongDays {
		t.Fatalf("keep_days=60 session_days = %v, want 60", body["session_days"])
	}
}

func TestV0985LoginRejectsWeakPassword(t *testing.T) {
	m := newAuthManager(t, filepath.Join(t.TempDir(), "sessions.json"))
	req := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(`{"username":"ADMIN","password":"wrong-password"}`))
	req.RemoteAddr = "192.168.112.9:41234"
	rec := httptest.NewRecorder()
	m.login(rec, req)
	if rec.Code == 200 {
		t.Fatal("wrong password must not authenticate")
	}
}

func TestV0985SessionsSurviveRestart(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "sessions.json")
	m := newAuthManager(t, file)
	_, cookie := loginRequest(t, m, `{"username":"ADMIN","password":"Test12345","keep_days":60}`)
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("login must persist the session table: %v", err)
	}

	// 模拟容器重建：新 manager 从同一文件恢复。
	m2 := newAuthManager(t, file)
	m2.loadSessions(file)
	req := httptest.NewRequest(http.MethodGet, "/api/system/runtime", nil)
	req.AddCookie(&cookie)
	ent, ok := m2.session(req)
	if !ok {
		t.Fatal("session must survive process restart (v0.9.85 持续登录)")
	}
	if sessionDaysFor(ent.days) != sessionLongDays {
		t.Fatalf("restored session days = %d, want 60", ent.days)
	}
	if time.Until(ent.expires) < 55*24*time.Hour {
		t.Fatalf("restored session expiry too soon: %v", time.Until(ent.expires))
	}
}

func TestV0985LogoutRevokesPersistedSession(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "sessions.json")
	m := newAuthManager(t, file)
	_, cookie := loginRequest(t, m, `{"username":"ADMIN","password":"Test12345"}`)

	req := httptest.NewRequest(http.MethodPost, "/api/logout", nil)
	req.AddCookie(&cookie)
	rec := httptest.NewRecorder()
	m.logout(rec, req)

	time.Sleep(20 * time.Millisecond)
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var doc sessionsDoc
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	if _, still := doc.Sessions[cookie.Value]; still {
		t.Fatal("logout must drop the session from the persisted table")
	}
}

func TestV0985SlidingRenewalKeepsSessionAlive(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "sessions.json")
	m := newAuthManager(t, file)
	_, cookie := loginRequest(t, m, `{"username":"ADMIN","password":"Test12345"}`)

	// 把会话到期时间手动压到 1 分钟后：一次请求应当续期回 30 天（不再是 30 分钟）。
	m.mu.Lock()
	ent := m.sessions[cookie.Value]
	ent.expires = time.Now().Add(time.Minute)
	m.sessions[cookie.Value] = ent
	m.mu.Unlock()

	req := httptest.NewRequest(http.MethodGet, "/api/system/runtime", nil)
	req.AddCookie(&cookie)
	renewed, ok := m.session(req)
	if !ok {
		t.Fatal("session should still be valid before expiry")
	}
	if time.Until(renewed.expires) < 29*24*time.Hour {
		t.Fatalf("sliding renewal must extend to 30 days, got %v", time.Until(renewed.expires))
	}
	if !m.sessionsDirty {
		t.Fatal("renewal must mark the session table dirty for the next flush")
	}
}

func TestV0985ExpiredSessionsPrunedOnLoad(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "sessions.json")
	doc := sessionsDoc{
		Version: 1,
		Sessions: map[string]sessionRecord{
			"live-sid":  {Expires: time.Now().Add(48 * time.Hour).UTC().Format(time.RFC3339), Days: 30},
			"stale-sid": {Expires: time.Now().Add(-time.Hour).UTC().Format(time.RFC3339), Days: 60},
		},
	}
	payload, _ := json.Marshal(doc)
	if err := os.WriteFile(file, payload, 0600); err != nil {
		t.Fatal(err)
	}
	m := newAuthManager(t, file)
	m.loadSessions(file)
	if _, ok := m.sessions["live-sid"]; !ok {
		t.Fatal("unexpired session must be restored")
	}
	if _, ok := m.sessions["stale-sid"]; ok {
		t.Fatal("expired session must not be restored")
	}
}

func TestV0985SessionPayloadCapsEntries(t *testing.T) {
	m := newAuthManager(t, filepath.Join(t.TempDir(), "sessions.json"))
	m.mu.Lock()
	for i := 0; i < sessionMaxEntries+40; i++ {
		m.sessions[string(rune('a'+i%26))+strings.Repeat("x", i%5)+":"+string(rune(i))] = sessionEntry{expires: time.Now().Add(time.Duration(i) * time.Minute), days: 30}
	}
	payload, err := m.sessionsPayloadLocked()
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	var doc sessionsDoc
	if err := json.Unmarshal(payload, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Sessions) > sessionMaxEntries {
		t.Fatalf("payload kept %d sessions, cap is %d", len(doc.Sessions), sessionMaxEntries)
	}
}
