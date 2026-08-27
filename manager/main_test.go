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
