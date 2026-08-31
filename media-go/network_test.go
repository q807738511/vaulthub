package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func TestValidateProxyURL(t *testing.T) {
	for _, raw := range []string{"", "http://192.168.112.3:7890", "https://proxy.example.com:8443"} {
		if _, err := validateProxyURL(raw); err != nil {
			t.Fatalf("valid proxy %q rejected: %v", raw, err)
		}
	}
	for _, raw := range []string{"file:///etc/passwd", "ftp://example.com", "http://", "http://user:pass@"} {
		if _, err := validateProxyURL(raw); err == nil {
			t.Fatalf("invalid proxy %q accepted", raw)
		}
	}
}

func TestMaskedProxyURL(t *testing.T) {
	if got := maskedProxyURL("http://user:secret@proxy.example.com:8080"); got != "http://user:***@proxy.example.com:8080" {
		t.Fatalf("credentials leaked or mask wrong: %q", got)
	}
}

func TestNetworkTargetsAreFixedAllowlist(t *testing.T) {
	if len(networkSpeedTargets) != 14 {
		t.Fatalf("target count=%d", len(networkSpeedTargets))
	}
	for _, host := range []string{"api.themoviedb.org", "api.thetvdb.com", "api.github.com", "raw.githubusercontent.com"} {
		if _, ok := networkSpeedTargets[host]; !ok {
			t.Fatalf("missing target %s", host)
		}
	}
}

func TestNetworkSpeedRequiresSessionAndRejectsUnknownTarget(t *testing.T) {
	old := managerSessionOK
	defer func() { managerSessionOK = old }()
	a := &App{}
	managerSessionOK = func(*http.Request) bool { return false }
	r := httptest.NewRequest(http.MethodPost, "/api/media/network/speed", nil)
	w := httptest.NewRecorder()
	a.networkSpeed(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("unauth status=%d", w.Code)
	}
	managerSessionOK = func(*http.Request) bool { return true }
	r = httptest.NewRequest(http.MethodGet, "/api/media/network/speed?host=evil.example", nil)
	w = httptest.NewRecorder()
	a.networkSpeed(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("unknown status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestTVDBSearchNormalizesSeries(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v4/login":
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"data":{"token":"token-1"}}`))
		case "/v4/search":
			if r.Header.Get("Authorization") != "Bearer token-1" {
				t.Fatal("missing TVDB bearer token")
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"data":[{"tvdb_id":"42","name":"三体","year":"2023","overview":"简介","image_url":"https://art.example/poster.jpg"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	oldClient := outboundHTTPClient
	defer func() { outboundHTTPClient = oldClient }()
	outboundHTTPClient = func(string) (*http.Client, error) { return server.Client(), nil }
	a := &App{tvdbAPIKey: "key", tvdbAPIBase: server.URL + "/v4"}
	old := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { managerSessionOK = old }()
	r := httptest.NewRequest(http.MethodGet, "/api/media/tvdb?query="+url.QueryEscape("三体"), nil)
	w := httptest.NewRecorder()
	a.tvdb(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	if body := w.Body.String(); body == "" || !containsAll(body, `"id":"42"`, `"name":"三体"`, `"poster_path":"https://art.example/poster.jpg"`) {
		t.Fatalf("unexpected body %s", body)
	}
}

func TestSpeedProbeReportsHTTPStatus(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	defer s.Close()
	result := probeNetworkTarget(s.Client(), "example", s.URL, 2*time.Second)
	if !result.OK || result.StatusCode != http.StatusNoContent || result.LatencyMS < 0 {
		t.Fatalf("result=%+v", result)
	}
}

func containsAll(s string, xs ...string) bool {
	for _, x := range xs {
		if !contains(s, x) {
			return false
		}
	}
	return true
}
func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	}())
}
