package main

import "testing"

// v0.9.85：TMDB language 白名单 —— 演职人员/简介随系统语言本地化。
// 前端只传 zh-CN / zh-TW / en-US（以及别名 en / zh），其余一律回落 zh-CN，
// 避免把任意查询串直接拼进上游 URL（注入面）。
func TestV0985TMDBLanguageWhitelist(t *testing.T) {
	cases := map[string]string{
		"":                              "zh-CN",
		"zh-CN":                         "zh-CN",
		"zh-cn":                         "zh-CN",
		"zh":                            "zh-CN",
		"zh-TW":                         "zh-TW",
		"zh-tw":                         "zh-TW",
		"zh-HK":                         "zh-TW",
		"en":                            "en-US",
		"en-US":                         "en-US",
		"en-us":                         "en-US",
		"EN":                            "en-US",
		"  en  ":                        "en-US",
		"ja-JP":                         "zh-CN",
		"../../x":                       "zh-CN",
		"zh-CN&append_to_response=hack": "zh-CN",
		"<script>":                      "zh-CN",
	}
	for in, want := range cases {
		if got := tmdbLanguage(in); got != want {
			t.Fatalf("tmdbLanguage(%q) = %q, want %q", in, got, want)
		}
	}
}

// 语言代码必须只含白名单字符集，任何输入都不会产出带 & / ? / 空格的串。
func TestV0985TMDBLanguageNoInjection(t *testing.T) {
	inputs := []string{"zh-CN", "zh-TW", "en-US", "ja", "en & x=1", "zh?lang=x", "%20", "\n"}
	allowed := map[string]bool{"zh-CN": true, "zh-TW": true, "en-US": true}
	for _, in := range inputs {
		if got := tmdbLanguage(in); !allowed[got] {
			t.Fatalf("tmdbLanguage(%q) = %q, not in whitelist", in, got)
		}
	}
}
