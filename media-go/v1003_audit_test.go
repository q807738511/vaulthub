package main

/* v1.0.3（需求3 · 全量审查）：SSRF 出站目标校验单测。
 *
 * 关键回归点：配置了 SCRAPER_PROXY 时，safeTransport 的 DialContext 校验不生效
 * （它连的是代理），所以「拒绝内网目标」必须由 ensurePublicTarget 在请求前完成。
 * 这里只测不需要 DNS 的用例（IP 字面量 / 本地域名后缀），避免单测依赖网络。
 */

import (
	"context"
	"net/url"
	"testing"
)

func TestV1003EnsurePublicTargetRejectsInternal(t *testing.T) {
	cases := []struct {
		raw     string
		wantErr bool
		why     string
	}{
		{"http://127.0.0.1:9099/api/session/check", true, "回环"},
		{"http://localhost/admin", true, "localhost"},
		{"http://[::1]/x", true, "IPv6 回环"},
		{"http://10.1.2.3/x", true, "私网 10/8"},
		{"http://172.16.0.9/x", true, "私网 172.16/12"},
		{"http://169.254.169.254/latest/meta-data", true, "链路本地/云元数据"},
		{"http://0.0.0.0/x", true, "未指定地址"},
		{"http://printer.local/x", true, ".local 后缀"},
		{"http://vault.internal/x", true, ".internal 后缀"},
		{"http://nas.lan/x", true, ".lan 后缀"},
		{"https://8.8.8.8/x", false, "公网 IP"},
		{"https://1.1.1.1/x", false, "公网 IP"},
	}
	for _, c := range cases {
		u, err := url.Parse(c.raw)
		if err != nil {
			t.Fatalf("parse %s: %v", c.raw, err)
		}
		got := ensurePublicTarget(context.Background(), u)
		if c.wantErr && got == nil {
			t.Fatalf("%s（%s）应被拒绝，实际通过", c.raw, c.why)
		}
		if !c.wantErr && got != nil {
			t.Fatalf("%s（%s）应放行，实际拒绝：%v", c.raw, c.why, got)
		}
	}
}

func TestV1003EnsurePublicTargetRejectsBadURL(t *testing.T) {
	if err := ensurePublicTarget(context.Background(), nil); err == nil {
		t.Fatalf("nil url 应被拒绝")
	}
	u, _ := url.Parse("http:///nohost")
	if err := ensurePublicTarget(context.Background(), u); err == nil {
		t.Fatalf("无主机名应被拒绝")
	}
}
