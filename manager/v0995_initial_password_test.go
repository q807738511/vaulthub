package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

/* v0.9.95（安全审查 M5 的回归测试）：一次性初始密码写文件（0600）、首登后被清除。
   路径用 INITIAL_PASSWORD_FILE 指到临时目录，不碰真实的 /data。 */

func TestV0995InitialPasswordFileMode(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sub", "initial-admin-password")
	t.Setenv("INITIAL_PASSWORD_FILE", path)

	if err := writeInitialPasswordFile("ADMIN", "Bootstrap9X"); err != nil {
		t.Fatalf("写初始密码文件失败：%v", err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读不回刚写的文件：%v", err)
	}
	body := string(b)
	if !strings.Contains(body, "username: ADMIN") || !strings.Contains(body, "password: Bootstrap9X") {
		t.Fatalf("文件内容不对：%q", body)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat 失败：%v", err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Fatalf("文件权限应为 0600，实际 %o（初始密码不能被同容器其它身份读到）", perm)
	}

	clearInitialPasswordFile()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("首登消费后文件应被删除，实际 err=%v", err)
	}
}

func TestV0995InitialPasswordPathOverride(t *testing.T) {
	t.Setenv("INITIAL_PASSWORD_FILE", "")
	if got := initialPasswordPath(); got != defaultInitialPasswordFile {
		t.Fatalf("没有覆盖时应回落到默认路径，实际 %q", got)
	}
	t.Setenv("INITIAL_PASSWORD_FILE", "/tmp/custom-pw-file")
	if got := initialPasswordPath(); got != "/tmp/custom-pw-file" {
		t.Fatalf("覆盖不生效：%q", got)
	}
}

/* 目录推导：写文件前要能把缺失的父目录建出来（/data 在容器里存在，但自定义路径不一定）。 */
func TestV0995DirOf(t *testing.T) {
	cases := map[string]string{
		"/data/initial-admin-password": "/data",
		"/tmp/a/b/pw":                  "/tmp/a/b",
		"relative-pw":                  "/",
		"/pw":                          "/",
	}
	for in, want := range cases {
		if got := dirOf(in); got != want {
			t.Fatalf("dirOf(%q)=%q，期望 %q", in, got, want)
		}
	}
}
