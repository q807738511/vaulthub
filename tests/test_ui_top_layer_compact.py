import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
JS = (ROOT / "web/js/03-features.js").read_text(encoding="utf-8")


def test_duplicate_home_count_row_removed():
    assert 'id="homeCount"' not in HTML
    assert 'id="topLibStat"' not in HTML


def test_content_is_raised_after_duplicate_count_removed():
    assert re.search(r"\.content\s*\{[^}]*padding:\s*8px 22px 56px", CSS)


def test_settings_uses_browser_top_layer_dialog():
    assert '<dialog class="modal-mask" id="settingsModal">' in HTML
    assert '</dialog>' in HTML
    assert 'typeof modal.showModal === "function"' in JS
    assert "modal.showModal()" in JS
    assert 'typeof modal.close === "function"' in JS
    assert "modal.close()" in JS
    assert "#settingsModal::backdrop" in CSS
