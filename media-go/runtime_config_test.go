package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestRuntimeConfigPersistsAndPreservesSecret(t *testing.T) {
	d := t.TempDir()
	a := &App{runtimeConfig: filepath.Join(d, "runtime.json"), tmdbAPIKey: "secret", cacheDir: filepath.Join(d, "old"), cacheWake: make(chan struct{}, 1)}
	c := RuntimeConfig{ScraperMode: "auto", TMDBAPIBase: "https://api.themoviedb.org/3", TMDBImageBase: "https://image.tmdb.org/t/p", TVDBAPIBase: "https://api4.thetvdb.com/v4", CacheDir: filepath.Join(d, "cache"), CacheMaxBytes: 1234, CacheMaxAgeHours: 12, CacheCleanupIntervalHours: 2}
	if err := a.saveRuntimeConfig(c); err != nil {
		t.Fatal(err)
	}
	if a.tmdbAPIKey != "secret" {
		t.Fatal("empty update erased existing API key")
	}
	if a.cacheDir != c.CacheDir || a.cacheCleanup != 2*time.Hour {
		t.Fatalf("runtime values not applied: %#v", a)
	}
	b, err := os.ReadFile(a.runtimeConfig)
	if err != nil {
		t.Fatal(err)
	}
	var saved RuntimeConfig
	if json.Unmarshal(b, &saved) != nil || saved.TMDBAPIKey != "secret" {
		t.Fatalf("secret/runtime config not persisted: %s", b)
	}
}

func TestRuntimeConfigPersistsTVDBAndProxy(t *testing.T) {
	d := t.TempDir()
	a := &App{runtimeConfig: filepath.Join(d, "runtime.json"), tmdbAPIKey: "tmdb-secret", tvdbAPIKey: "tvdb-secret", scraperProxy: "http://192.168.112.3:7890", cacheDir: filepath.Join(d, "old"), cacheWake: make(chan struct{}, 1)}
	c := RuntimeConfig{ScraperMode: "auto", TMDBAPIBase: "https://api.themoviedb.org/3", TMDBImageBase: "https://image.tmdb.org/t/p", TVDBAPIBase: "https://api4.thetvdb.com/v4", CacheDir: filepath.Join(d, "cache"), CacheMaxBytes: 1, CacheMaxAgeHours: 1, CacheCleanupIntervalHours: 1}
	if err := a.saveRuntimeConfig(c); err != nil {
		t.Fatal(err)
	}
	if a.tvdbAPIKey != "tvdb-secret" || a.scraperProxy != "http://192.168.112.3:7890" {
		t.Fatalf("secret/proxy not preserved: %#v", a)
	}
	b, err := os.ReadFile(a.runtimeConfig)
	if err != nil {
		t.Fatal(err)
	}
	var saved RuntimeConfig
	if json.Unmarshal(b, &saved) != nil || saved.TVDBAPIKey != "tvdb-secret" || saved.ScraperProxy != "http://192.168.112.3:7890" {
		t.Fatalf("runtime values not persisted: %s", b)
	}
}

func TestRuntimeConfigCanClearProxyExplicitly(t *testing.T) {
	d := t.TempDir()
	a := &App{runtimeConfig: filepath.Join(d, "runtime.json"), scraperProxy: "http://192.168.112.3:7890", cacheDir: filepath.Join(d, "old"), cacheWake: make(chan struct{}, 1)}
	c := RuntimeConfig{ScraperMode: "auto", TMDBAPIBase: "https://api.themoviedb.org/3", TMDBImageBase: "https://image.tmdb.org/t/p", TVDBAPIBase: "https://api4.thetvdb.com/v4", ScraperProxySet: true, CacheDir: filepath.Join(d, "cache"), CacheMaxBytes: 1, CacheMaxAgeHours: 1, CacheCleanupIntervalHours: 1}
	if err := a.saveRuntimeConfig(c); err != nil {
		t.Fatal(err)
	}
	if a.scraperProxy != "" {
		t.Fatalf("proxy was not cleared: %q", a.scraperProxy)
	}
}

func TestLoadRuntimeConfigKeepsExplicitlyClearedProxy(t *testing.T) {
	d := t.TempDir()
	p := filepath.Join(d, "runtime.json")
	b, _ := json.Marshal(RuntimeConfig{ScraperProxySet: true})
	if os.WriteFile(p, b, 0600) != nil {
		t.Fatal("write fixture")
	}
	a := &App{runtimeConfig: p, scraperProxy: "http://192.168.112.3:7890"}
	a.loadRuntimeConfig()
	if a.scraperProxy != "" {
		t.Fatalf("restart restored cleared proxy: %q", a.scraperProxy)
	}
}

func TestRuntimeConfigRejectsUnsafeValues(t *testing.T) {
	a := &App{runtimeConfig: filepath.Join(t.TempDir(), "runtime.json"), cacheWake: make(chan struct{}, 1)}
	base := RuntimeConfig{ScraperMode: "auto", TMDBAPIBase: "https://api.themoviedb.org/3", TMDBImageBase: "https://image.tmdb.org/t/p", TVDBAPIBase: "https://api4.thetvdb.com/v4", CacheDir: "/tmp/cache", CacheMaxBytes: 1, CacheMaxAgeHours: 1, CacheCleanupIntervalHours: 1}
	bad := base
	bad.CacheDir = "relative/cache"
	if a.saveRuntimeConfig(bad) == nil {
		t.Fatal("accepted relative cache directory")
	}
	bad = base
	bad.TMDBAPIBase = "file:///etc/passwd"
	if a.saveRuntimeConfig(bad) == nil {
		t.Fatal("accepted non-http TMDB URL")
	}
	for _, target := range []string{"http://127.0.0.1:9099", "http://localhost:9099", "http://169.254.169.254/latest", "http://192.168.1.10/api"} {
		bad = base
		bad.TMDBAPIBase = target
		if a.saveRuntimeConfig(bad) == nil {
			t.Fatalf("accepted private TMDB target %s", target)
		}
	}
	bad = base
	bad.ScraperMode = "shell"
	if a.saveRuntimeConfig(bad) == nil {
		t.Fatal("accepted invalid scraper mode")
	}
}

func TestRuntimeConfigConcurrentSavesRemainValid(t *testing.T) {
	d := t.TempDir()
	a := &App{runtimeConfig: filepath.Join(d, "runtime.json"), cacheWake: make(chan struct{}, 1)}
	base := RuntimeConfig{ScraperMode: "auto", TMDBAPIBase: "https://api.themoviedb.org/3", TMDBImageBase: "https://image.tmdb.org/t/p", TVDBAPIBase: "https://api4.thetvdb.com/v4", CacheDir: filepath.Join(d, "cache"), CacheMaxAgeHours: 1, CacheCleanupIntervalHours: 1}
	var wg sync.WaitGroup
	errCh := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			c := base
			c.CacheMaxBytes = int64(n + 1)
			errCh <- a.saveRuntimeConfig(c)
		}(i)
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			t.Fatal(err)
		}
	}
	b, err := os.ReadFile(a.runtimeConfig)
	if err != nil {
		t.Fatal(err)
	}
	var saved RuntimeConfig
	if json.Unmarshal(b, &saved) != nil || saved.CacheMaxBytes < 1 || saved.CacheMaxBytes > 20 {
		t.Fatalf("invalid concurrent result: %s", b)
	}
}

func TestCleanCacheUsesRuntimeLimits(t *testing.T) {
	d := t.TempDir()
	old := filepath.Join(d, "old.mp4")
	newer := filepath.Join(d, "new.mp4")
	if os.WriteFile(old, make([]byte, 8), 0600) != nil || os.WriteFile(newer, make([]byte, 8), 0600) != nil {
		t.Fatal("fixture write")
	}
	past := time.Now().Add(-2 * time.Hour)
	_ = os.Chtimes(old, past, past)
	a := &App{cacheDir: d, cacheMaxBytes: 10, cacheMaxAge: time.Hour}
	a.cleanCache()
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("expired cache survived")
	}
	if _, err := os.Stat(newer); err != nil {
		t.Fatal("new cache was removed")
	}
}
