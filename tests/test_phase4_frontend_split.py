#!/usr/bin/env python3
"""Phase 4 contract: frontend split into web/css and web/js with load-order
integrity, plus phase-5 service-split decision doc presence."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
index = (ROOT / "index.html").read_text(encoding="utf-8")

# index.html no longer inlines the whole app.
assert '<link rel="stylesheet" href="/web/css/main.css">' in index
for f in ["01-state.js", "02-media.js", "03-features.js", "04-boot.js"]:
    assert f'<script src="/web/js/{f}"></script>' in index, f"missing script tag {f}"

# The split assets must exist.
css = ROOT / "web" / "css" / "main.css"
assert css.exists() and css.stat().st_size > 0
js_files = ["01-state.js", "02-media.js", "03-features.js", "04-boot.js"]
for f in js_files:
    p = ROOT / "web" / "js" / f
    assert p.exists() and p.stat().st_size > 0, f"missing {f}"

# Load order in index.html must match the numeric file order (boot last).
order = re.findall(r'/web/js/(0\d-[a-z]+\.js)', index)
assert order == js_files, f"script load order wrong: {order}"

# Boot statements (init calls) must live in the LAST file so all functions and
# globals from earlier files are defined before they run.
boot = (ROOT / "web" / "js" / "04-boot.js").read_text(encoding="utf-8")
for call in ["loadSettings();", "requireVaultHubLogin();", "setInterval(tickMetrics, 5000);"]:
    assert call in boot, f"boot file missing init call: {call}"

# Classic (non-module) scripts: inline on*= handlers need global functions.
assert "type=\"module\"" not in index and "type='module'" not in index, \
    "must stay classic scripts so inline handlers keep global scope"

# Phase 5 decision doc exists and records the 'do not split yet' decision.
doc = ROOT / "docs" / "architecture-phase5-service-split.md"
assert doc.exists(), "missing phase 5 decision doc"
dtext = doc.read_text(encoding="utf-8")
for kw in ["vaulthub-web", "vaulthub-media", "vaulthub-worker", "vaulthub-indexer"]:
    assert kw in dtext, f"decision doc missing service name {kw}"

print("PASS: phase 4 frontend split + phase 5 decision doc present and ordered")
