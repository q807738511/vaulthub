package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// v0.9.54：鉴权模式与账户持久化单测。
//  1. 环境变量推导：ADMIN_PASSWORD 为空 → open；非空 → password（hash 可验）。
//  2. auth.json 读写往返 + 文件优先于环境变量。
//  3. 密码校验（常数时间比较路径）与错误密码拒绝。
//  4. 开放模式：密码校验恒 false（不应被调用），require 放行逻辑在 handler 层。
func TestV0954DeriveStoredAuthOpenWhenNoPassword(t *testing.T) {
	s := deriveStoredAuth("", "")
	if s.Mode != "open" {
		t.Fatalf("empty ADMIN_PASSWORD must yield open mode, got %q", s.Mode)
	}
	if s.Username != "ADMIN" {
		t.Fatalf("default username should be ADMIN, got %q", s.Username)
	}
	s2 := deriveStoredAuth("admin", "")
	if s2.Username != "admin" || s2.Mode != "open" {
		t.Fatalf("open mode must keep username, got %+v", s2)
	}
}

func TestV0954DeriveStoredAuthPasswordHashes(t *testing.T) {
	s := deriveStoredAuth("ADMIN", "s3cret-!pw")
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
	// open mode round trip: hash dropped
	m3 := &manager{authFile: file}
	m3.username = "newbie"
	m3.open = true
	if err := m3.saveAuthFile(); err != nil {
		t.Fatalf("save open: %v", err)
	}
	m4 := &manager{}
	if !m4.loadAuthFile(file) || !m4.open || m4.hash != "" {
		t.Fatalf("open mode round trip failed: %+v", m4)
	}
	if m4.passwordOK("hello123") {
		t.Fatal("open mode must not verify any password")
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
