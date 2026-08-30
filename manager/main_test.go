package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const legacyCaddyfile = `:8088 {
	encode zstd gzip

	handle /api/media/* {
		reverse_proxy http://127.0.0.1:9100
	}

	handle {
		root * /srv
		file_server
	}
}
`

// TestNormalizeCaddyfileInjectsMultilineBlocks guards the v0.6.23 regression
// where a single-line handle block made Caddy validation fail and the container
// restarted forever.
func TestNormalizeCaddyfileInjectsMultilineBlocks(t *testing.T) {
	out := string(normalizeCaddyfile([]byte(legacyCaddyfile)))
	for _, route := range managerRoutes {
		want := "\t" + route + " {\n\t\treverse_proxy http://127.0.0.1:9099\n\t}"
		if !strings.Contains(out, want) {
			t.Fatalf("route %q was not injected as a multiline block:\n%s", route, out)
		}
		if strings.Contains(out, route+" { reverse_proxy") {
			t.Fatalf("route %q was injected as an invalid single-line block", route)
		}
	}
}

// TestNormalizeCaddyfileIsIdempotent ensures repeated container starts do not
// accumulate duplicate handle blocks in /data/Caddyfile.
func TestNormalizeCaddyfileIsIdempotent(t *testing.T) {
	first := normalizeCaddyfile([]byte(legacyCaddyfile))
	second := normalizeCaddyfile(first)
	if string(first) != string(second) {
		t.Fatalf("normalizeCaddyfile is not idempotent:\nfirst:\n%s\nsecond:\n%s", first, second)
	}
	for _, route := range managerRoutes {
		if n := strings.Count(string(second), route+" {"); n != 1 {
			t.Fatalf("route %q appears %d times after two migrations", route, n)
		}
	}
}

// TestNormalizeCaddyfileKeepsExistingRoutes verifies an already-migrated file is
// returned untouched.
func TestNormalizeCaddyfileKeepsExistingRoutes(t *testing.T) {
	migrated := normalizeCaddyfile([]byte(legacyCaddyfile))
	if got := normalizeCaddyfile(migrated); string(got) != string(migrated) {
		t.Fatal("already migrated Caddyfile was modified again")
	}
}

// TestMigratedCaddyfileValidates runs the bundled Caddy binary when present so
// the generated syntax is proven, not assumed.
func TestMigratedCaddyfileValidates(t *testing.T) {
	caddy := ""
	for _, c := range []string{"/usr/bin/caddy", filepath.Join("..", "caddy")} {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			caddy = c
			break
		}
	}
	if caddy == "" {
		t.Skip("caddy binary not available")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "Caddyfile")
	if err := os.WriteFile(path, normalizeCaddyfile([]byte(legacyCaddyfile)), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(caddy, "validate", "--config", path, "--adapter", "caddyfile").CombinedOutput()
	if err != nil {
		t.Fatalf("migrated Caddyfile failed validation: %v\n%s", err, out)
	}
}

// TestNormalizeCaddyfileInjectsCachePolicy guards the v0.8.6 regression: the
// container prefers the persisted /data/Caddyfile over the image's
// /etc/caddy/Caddyfile, so upgrading the image alone would NOT deliver the new
// cache headers. Existing installs must be migrated in place, otherwise the
// browser keeps executing the stale bundle this release is meant to fix.
func TestNormalizeCaddyfileInjectsCachePolicy(t *testing.T) {
	out := string(normalizeCaddyfile([]byte(legacyCaddyfile)))
	for _, want := range []string{
		"VAULTHUB-CACHE-POLICY",
		"handle /web/* {",
		"@versioned_asset",
		"public, max-age=31536000, immutable",
		"@unversioned_asset",
		"public, max-age=300, must-revalidate",
		"@web_miss not file",
		"no-store, must-revalidate",
		"try_files {path} /index.html",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("cache policy fragment %q missing after migration:\n%s", want, out)
		}
	}
	// The policy must land inside the static file-serving block, before try_files.
	policyAt := strings.Index(out, "VAULTHUB-CACHE-POLICY")
	rootAt := strings.Index(out, "root *")
	if policyAt < rootAt {
		t.Fatalf("cache policy inserted before the static root directive:\n%s", out)
	}
	if try := strings.Index(out, "try_files"); try >= 0 && policyAt > try {
		t.Fatalf("cache policy must be inserted before try_files:\n%s", out)
	}
}

// TestNormalizeCaddyfileCachePolicyIsIdempotent ensures repeated container
// starts do not stack duplicate cache-policy blocks in /data/Caddyfile.
func TestNormalizeCaddyfileCachePolicyIsIdempotent(t *testing.T) {
	first := normalizeCaddyfile([]byte(legacyCaddyfile))
	second := normalizeCaddyfile(first)
	if string(first) != string(second) {
		t.Fatalf("cache policy migration is not idempotent:\nfirst:\n%s\nsecond:\n%s", first, second)
	}
	if n := strings.Count(string(second), "@versioned_asset {"); n != 1 {
		t.Fatalf("@versioned_asset appears %d times after two migrations", n)
	}
}

// TestNormalizeCaddyfileKeepsUserCachePolicy verifies a file that already
// carries the policy marker is left alone, so operator edits survive restarts.
func TestNormalizeCaddyfileKeepsUserCachePolicy(t *testing.T) {
	custom := strings.Replace(legacyCaddyfile, "		file_server\n",
		"		# VAULTHUB-CACHE-POLICY v1\n		header Cache-Control \"no-store\"\n		# VAULTHUB-CACHE-POLICY-END\n		file_server\n", 1)
	out := string(normalizeCaddyfile([]byte(custom)))
	if strings.Contains(out, "@versioned_asset") {
		t.Fatal("existing cache policy was overwritten instead of preserved")
	}
	if !strings.Contains(out, "header Cache-Control \"no-store\"") {
		t.Fatal("operator's own cache policy was dropped")
	}
}

// TestNormalizeCaddyfileSkipsOnMatcherCollision guards a crash-loop: Caddy
// rejects a config that defines the same named matcher twice, and the manager
// treats validation failure as fatal. A file that already uses any of the policy
// matcher names (e.g. an earlier hand-rolled cache block) must be left untouched
// rather than gaining a duplicate definition.
func TestNormalizeCaddyfileSkipsOnMatcherCollision(t *testing.T) {
	for _, name := range []string{"@versioned_asset", "@unversioned_asset", "@web_miss"} {
		existing := strings.Replace(legacyCaddyfile, "		file_server\n",
			"		"+name+" path /web/*\n		header "+name+" Cache-Control \"public\"\n		file_server\n", 1)
		out := string(normalizeCaddyfile([]byte(existing)))
		if strings.Contains(out, cachePolicyMarker) {
			t.Fatalf("policy was injected despite existing matcher %s, Caddy would reject the config:\n%s", name, out)
		}
		before := strings.Count(existing, name)
		if after := strings.Count(out, name); after != before {
			t.Fatalf("matcher %s went from %d to %d occurrences (duplicate definition crashes Caddy)", name, before, after)
		}
	}
}

// TestNormalizeCaddyfileWithoutStaticRoot ensures a Caddyfile with no `root *`
// anchor is passed through instead of being mangled.
func TestNormalizeCaddyfileWithoutStaticRoot(t *testing.T) {
	noRoot := ":8088 {\n	handle /api/media/* {\n		reverse_proxy http://127.0.0.1:9100\n	}\n}\n"
	out := string(normalizeCaddyfile([]byte(noRoot)))
	if strings.Contains(out, cachePolicyMarker) {
		t.Fatalf("cache policy injected without a static root to anchor it:\n%s", out)
	}
}

// TestNormalizeCaddyfileRemovesLegacyStaticServe proves the migration strips the
// old top-level try_files/file_server pair. Leaving them behind would keep the
// SPA fallback alive for /web/*, so a missing asset would answer 200 text/html
// and be cached as a script — exactly the bug v0.8.6 fixes.
func TestNormalizeCaddyfileRemovesLegacyStaticServe(t *testing.T) {
	legacyStatic := ":8088 {\n\thandle {\n\t\troot * /srv\n\t\ttry_files {path} /index.html\n\t\tfile_server\n\t\theader {\n\t\t\tX-Content-Type-Options nosniff\n\t\t}\n\t}\n}\n"
	out := string(normalizeCaddyfile([]byte(legacyStatic)))
	if n := strings.Count(out, "try_files {path} /index.html"); n != 1 {
		t.Fatalf("expected exactly one try_files (inside the policy block), got %d:\n%s", n, out)
	}
	// The surviving try_files must sit inside the policy's entry handle, i.e.
	// after the /web/* handle that owns static assets.
	webAt := strings.Index(out, "handle /web/* {")
	tryAt := strings.Index(out, "try_files {path} /index.html")
	if webAt < 0 || tryAt < webAt {
		t.Fatalf("try_files must live after the /web/* handle:\n%s", out)
	}
	// Unrelated headers outside the policy must survive.
	if !strings.Contains(out, "X-Content-Type-Options nosniff") {
		t.Fatalf("unrelated directives were dropped:\n%s", out)
	}
}

// TestMigratedCachePolicyValidatesAndServes proves the injected policy is not
// just textually present but actually adapts and serves the intended headers.
func TestMigratedCachePolicyValidates(t *testing.T) {
	caddy := ""
	for _, c := range []string{"/usr/bin/caddy", filepath.Join("..", "caddy")} {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			caddy = c
			break
		}
	}
	if caddy == "" {
		t.Skip("caddy binary not available")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "Caddyfile")
	if err := os.WriteFile(path, normalizeCaddyfile([]byte(legacyCaddyfile)), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(caddy, "adapt", "--config", path, "--adapter", "caddyfile").CombinedOutput()
	if err != nil {
		t.Fatalf("migrated Caddyfile with cache policy failed to adapt: %v\n%s", err, out)
	}
	for _, want := range []string{"max-age=31536000", "no-store"} {
		if !strings.Contains(string(out), want) {
			t.Fatalf("adapted JSON config lacks %q:\n%s", want, out)
		}
	}
}
