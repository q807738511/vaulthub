package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var networkSpeedTargets = map[string]string{
	"api.themoviedb.org":        "https://api.themoviedb.org/3/configuration",
	"api.tmdb.org":              "https://api.tmdb.org/",
	"www.themoviedb.org":        "https://www.themoviedb.org/",
	"api.thetvdb.com":           "https://api.thetvdb.com/",
	"webservice.fanart.tv":      "https://webservice.fanart.tv/",
	"api.telegram.org":          "https://api.telegram.org/",
	"qyapi.weixin.qq.com":       "https://qyapi.weixin.qq.com/",
	"frodo.douban.com":          "https://frodo.douban.com/",
	"slack.com":                 "https://slack.com/",
	"pypi.org":                  "https://pypi.org/",
	"github.com":                "https://github.com/",
	"api.github.com":            "https://api.github.com/",
	"codeload.github.com":       "https://codeload.github.com/",
	"raw.githubusercontent.com": "https://raw.githubusercontent.com/",
}

func validateProxyURL(raw string) (*url.URL, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("代理仅支持 http/https 地址，例如 http://192.168.112.3:7890")
	}
	if u.Port() != "" {
		if p, err := strconv.Atoi(u.Port()); err != nil || p < 1 || p > 65535 {
			return nil, fmt.Errorf("代理端口无效")
		}
	}
	return u, nil
}

func maskedProxyURL(raw string) string {
	u, err := validateProxyURL(raw)
	if err != nil || u == nil {
		return ""
	}
	if u.User != nil {
		user := u.User.Username()
		u.User = nil
		return u.Scheme + "://" + user + ":***@" + u.Host
	}
	return u.String()
}

func safeTransport(proxyRaw string) (*http.Transport, error) {
	proxyURL, err := validateProxyURL(proxyRaw)
	if err != nil {
		return nil, err
	}
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	tr := &http.Transport{TLSHandshakeTimeout: 6 * time.Second, ResponseHeaderTimeout: 8 * time.Second, IdleConnTimeout: 30 * time.Second, MaxIdleConns: 32, MaxIdleConnsPerHost: 4, MaxConnsPerHost: 8}
	if proxyURL != nil {
		tr.Proxy = http.ProxyURL(proxyURL)
		tr.DialContext = dialer.DialContext
		return tr, nil
	}
	tr.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil || len(ips) == 0 {
			return nil, fmt.Errorf("target resolution failed")
		}
		for _, x := range ips {
			if !publicIP(x.IP) {
				return nil, fmt.Errorf("private target rejected")
			}
		}
		return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
	}
	return tr, nil
}

var outboundHTTPClient = func(proxyRaw string) (*http.Client, error) {
	tr, err := safeTransport(proxyRaw)
	if err != nil {
		return nil, err
	}
	c := &http.Client{Timeout: 12 * time.Second, Transport: tr}
	c.CheckRedirect = func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }
	return c, nil
}

type networkSpeedResult struct {
	Host       string `json:"host"`
	OK         bool   `json:"ok"`
	Reachable  bool   `json:"reachable"`
	StatusCode int    `json:"status_code"`
	LatencyMS  int64  `json:"latency_ms"`
	Route      string `json:"route"`
	Error      string `json:"error,omitempty"`
}

func probeNetworkTarget(client *http.Client, host, target string, timeout time.Duration) networkSpeedResult {
	start := time.Now()
	out := networkSpeedResult{Host: host, Route: "direct"}
	if client == nil {
		out.Error = "client unavailable"
		return out
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, target, nil)
	if err != nil {
		out.Error = "invalid target"
		return out
	}
	req.Header.Set("User-Agent", "VaultHub-Network-Diagnostics")
	res, err := client.Do(req)
	out.LatencyMS = time.Since(start).Milliseconds()
	if err != nil {
		out.Error = "连接失败或超时"
		return out
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
	out.StatusCode = res.StatusCode
	out.Reachable = true
	out.OK = true
	return out
}

func (a *App) networkSpeed(w http.ResponseWriter, r *http.Request) {
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		errJSON(w, 405, "method not allowed")
		return
	}
	host := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(r.URL.Query().Get("host")), "."))
	if host != "" {
		if _, ok := networkSpeedTargets[host]; !ok {
			errJSON(w, 400, "target is not allowed")
			return
		}
	}
	a.mu.RLock()
	proxy := a.scraperProxy
	a.mu.RUnlock()
	client, err := outboundHTTPClient(proxy)
	if err != nil {
		errJSON(w, 400, err.Error())
		return
	}
	hosts := make([]string, 0, len(networkSpeedTargets))
	if host != "" {
		hosts = []string{host}
	} else {
		for h := range networkSpeedTargets {
			hosts = append(hosts, h)
		}
		sort.Strings(hosts)
	}
	results := make([]networkSpeedResult, len(hosts))
	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for i, h := range hosts {
		wg.Add(1)
		go func(i int, h string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			results[i] = probeNetworkTarget(client, h, networkSpeedTargets[h], 8*time.Second)
			if proxy != "" {
				results[i].Route = "proxy"
			}
		}(i, h)
	}
	wg.Wait()
	writeJSON(w, 200, map[string]any{"ok": true, "proxy_enabled": proxy != "", "proxy": maskedProxyURL(proxy), "results": results})
}

func (a *App) tvdb(w http.ResponseWriter, r *http.Request) {
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	if r.Method != http.MethodGet {
		errJSON(w, 405, "method not allowed")
		return
	}
	query := strings.TrimSpace(r.URL.Query().Get("query"))
	if query == "" || len(query) > 200 {
		errJSON(w, 400, "invalid TVDB query")
		return
	}
	a.mu.RLock()
	key, base, proxy := a.tvdbAPIKey, a.tvdbAPIBase, a.scraperProxy
	a.mu.RUnlock()
	if key == "" {
		errJSON(w, 400, "TVDB_API_KEY is not configured")
		return
	}
	client, err := outboundHTTPClient(proxy)
	if err != nil {
		errJSON(w, 400, err.Error())
		return
	}
	loginBody, _ := json.Marshal(map[string]string{"apikey": key})
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	loginReq, _ := http.NewRequestWithContext(ctx, http.MethodPost, base+"/login", bytes.NewReader(loginBody))
	loginReq.Header.Set("Content-Type", "application/json")
	loginRes, err := client.Do(loginReq)
	if err != nil {
		errJSON(w, 502, "tvdb login failed")
		return
	}
	defer loginRes.Body.Close()
	var login struct {
		Data struct {
			Token string `json:"token"`
		} `json:"data"`
	}
	if loginRes.StatusCode/100 != 2 || json.NewDecoder(io.LimitReader(loginRes.Body, 1<<20)).Decode(&login) != nil || login.Data.Token == "" {
		errJSON(w, 502, "tvdb login failed")
		return
	}
	q := url.Values{"query": {query}, "type": {"series"}}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, base+"/search?"+q.Encode(), nil)
	req.Header.Set("Authorization", "Bearer "+login.Data.Token)
	res, err := client.Do(req)
	if err != nil {
		errJSON(w, 502, "tvdb scrape failed")
		return
	}
	defer res.Body.Close()
	var raw struct {
		Data []struct {
			TVDBID   any    `json:"tvdb_id"`
			Name     string `json:"name"`
			Year     string `json:"year"`
			Overview string `json:"overview"`
			Image    string `json:"image_url"`
		} `json:"data"`
	}
	if res.StatusCode/100 != 2 || json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&raw) != nil {
		errJSON(w, 502, "tvdb scrape failed")
		return
	}
	items := make([]map[string]any, 0, len(raw.Data))
	for _, x := range raw.Data {
		items = append(items, map[string]any{"id": fmt.Sprint(x.TVDBID), "name": x.Name, "first_air_date": x.Year, "overview": x.Overview, "poster_path": x.Image})
	}
	writeJSON(w, 200, map[string]any{"results": items})
}
