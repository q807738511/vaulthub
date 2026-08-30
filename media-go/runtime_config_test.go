package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRuntimeConfigPersistsAndPreservesSecret(t *testing.T) {
	d := t.TempDir()
	a := &App{runtimeConfig: filepath.Join(d, "runtime.json"), tmdbAPIKey: "secret", cacheDir: filepath.Join(d, "old"), cacheWake: make(chan struct{}, 1)}
	c := RuntimeConfig{ScraperMode: "auto", TMDBAPIBase: "https://api.themoviedb.org/3", TMDBImageBase: "https://image.tmdb.org/t/p", CacheDir: filepath.Join(d, "cache"), CacheMaxBytes: 1234, CacheMaxAgeHours: 12, CacheCleanupIntervalHours: 2}
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

func TestRuntimeConfigRejectsUnsafeValues(t *testing.T) {
	a := &App{runtimeConfig: filepath.Join(t.TempDir(), "runtime.json"), cacheWake: make(chan struct{}, 1)}
	base := RuntimeConfig{ScraperMode: "auto", TMDBAPIBase: "https://api.themoviedb.org/3", TMDBImageBase: "https://image.tmdb.org/t/p", CacheDir: "/tmp/cache", CacheMaxBytes: 1, CacheMaxAgeHours: 1, CacheCleanupIntervalHours: 1}
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
	bad = base
	bad.ScraperMode = "shell"
	if a.saveRuntimeConfig(bad) == nil {
		t.Fatal("accepted invalid scraper mode")
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
