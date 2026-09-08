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


def test_settings_uses_dedicated_page_not_a_dialog():
    # v0.9.30: 系统设置从 <dialog> 顶层弹窗改成独立配置页 #view-settings。
    # 弹窗被 .modal.wide 限死在 720px，媒体库表单必须二次滚动；
    # 配置页用内容区宽度，侧栏与顶栏保持可用。
    assert 'id="settingsModal"' not in HTML
    assert "<dialog" not in HTML
    assert '<section class="view settings-view" id="view-settings">' in HTML
    assert 'id="setpanel-library"' in HTML and 'id="setpanel-account"' in HTML
    # 其它弹窗仍用 openModal/closeModal，这套开关必须保留。
    assert 'typeof modal.showModal === "function"' in JS
    assert 'typeof modal.close === "function"' in JS
    assert ".settings-view .setpanel" in CSS
