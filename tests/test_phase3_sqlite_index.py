#!/usr/bin/env python3
"""Phase 3 contract: SQLite-backed index with non-blocking background scans.

Static assertions over media-go/main.go so the CI runner (no built binary)
still guards the design. Runtime behaviour is verified separately by the
isolated container/binary tests during release.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
media = (ROOT / "media-go" / "main.go").read_text(encoding="utf-8")
gomod = (ROOT / "media-go" / "go.mod").read_text(encoding="utf-8")

# Pure-Go SQLite driver, no cgo.
assert "modernc.org/sqlite" in gomod, "go.mod must require modernc.org/sqlite"
assert '_ "modernc.org/sqlite"' in media, "main.go must import the sqlite driver"

# Schema: files + index_status tables, indexed by library.
assert "CREATE TABLE IF NOT EXISTS files(" in media
assert "CREATE INDEX IF NOT EXISTS idx_files_lib ON files(lib)" in media
assert "CREATE TABLE IF NOT EXISTS index_status(" in media

# WAL + busy timeout so reads proceed during a rebuild.
assert "journal_mode(WAL)" in media
assert "busy_timeout(" in media

# Endpoints.
assert 'mux.HandleFunc("/api/media/index/rebuild", a.rebuild)' in media
assert 'mux.HandleFunc("/api/media/index/status", a.indexStatus)' in media
assert 'mux.HandleFunc("/api/media/index/cancel", a.indexCancel)' in media

# rebuild is a background scheduler (202) and requires auth; status/files read DB.
assert 'writeJSON(w, 202, map[string]any{"ok": true, "status": "scheduled"' in media
assert "func (a *App) rebuild(" in media and "if !writeAuth(r)" in media
assert "func (a *App) indexStatus(" in media
assert "func (a *App) indexCancel(" in media

# files() must query SQLite (LIMIT/OFFSET), not walk the filesystem inline.
assert "SELECT path,size,mtime FROM files WHERE lib=? ORDER BY path LIMIT ? OFFSET ?" in media
# The in-memory index map is gone.
assert "a.indexes" not in media, "legacy in-memory index map must be removed"

# Scan walks WITHOUT holding the DB write lock, then swaps under a single-writer
# gate in bounded batches — this is what keeps light endpoints responsive.
assert "scanGate" in media
assert "a.scanGate <- struct{}{}" in media
assert "const batch =" in media

# Per-library cancellation.
assert "scanCancel" in media and "context.WithCancel" in media

print("PASS: phase 3 SQLite index, background scans, rebuild/status/cancel wired")
