"""Shared frontend-source loader for VaultHub tests.

Phase 4 split the single index.html into web/css/main.css and web/js/*.js.
Tests that string-match frontend markers should look at the whole frontend, not
just index.html, so this helper returns index.html plus every split asset
concatenated. Existing tests keep working regardless of how the frontend is
chopped up, as long as the marker exists somewhere in the shipped frontend.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def frontend_source() -> str:
    parts = []
    idx = ROOT / "index.html"
    if idx.exists():
        parts.append(idx.read_text(encoding="utf-8"))
    web = ROOT / "web"
    if web.is_dir():
        for p in sorted(web.rglob("*")):
            if p.suffix.lower() in (".js", ".css", ".html"):
                parts.append(p.read_text(encoding="utf-8"))
    return "\n".join(parts)
