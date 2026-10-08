package main

import (
	"os"
	"strings"
)

/* v0.9.95（独立安全审查 M5）：一次性初始管理员密码不再打进容器日志。
   docker logs 会被日志采集/转发，明文初始口令进日志等于进了转发链；改成写
   /data/initial-admin-password（0600），日志只说「去哪看」，文件在首次登录
   消费掉这条密码时删除。设计取舍：文件写不进去时才退回打印一次，否则用户
   拿不到初始密码就等于被锁在门外（可用 ADMIN_PASSWORD 显式指定来完全避开
   这条路径）。 */

const defaultInitialPasswordFile = "/data/initial-admin-password"

/* 路径可用 INITIAL_PASSWORD_FILE 覆盖（与 MEDIA_CACHE_DIR 同一套约定）：
   测试里指到临时目录，避免动真实的 /data。 */
func initialPasswordPath() string {
	if p := strings.TrimSpace(os.Getenv("INITIAL_PASSWORD_FILE")); p != "" {
		return p
	}
	return defaultInitialPasswordFile
}

func writeInitialPasswordFile(user, pw string) error {
	path := initialPasswordPath()
	if err := os.MkdirAll(dirOf(path), 0o755); err != nil {
		return err
	}
	body := []byte("username: " + user + "\npassword: " + pw + "\n")
	return os.WriteFile(path, body, 0o600)
}

func clearInitialPasswordFile() {
	_ = os.Remove(initialPasswordPath())
}

func dirOf(path string) string {
	i := strings.LastIndex(path, "/")
	if i <= 0 {
		return "/"
	}
	return path[:i]
}
