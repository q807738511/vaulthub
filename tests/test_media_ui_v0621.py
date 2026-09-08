from pathlib import Path

import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(__file__))
from _frontend import frontend_source as _fs
html = _fs()
checks = {
    "brand title": '<strong class="brand-title">VaultHub</strong>' in html,
    "brand subtitle": '蜀鼠之家，承包你的所有休闲内容' in html,
    "collapsed reader follows sidebar": 'body.sidebar-hidden .media-reader-overlay { left:60px;' in html,
    "mobile reader ignores sidebar": '@media (max-width: 768px)' in html and '.media-reader-overlay { left:0;' in html,
    "video information button": 'class="video-info-button"' in html and 'aria-label="播放及媒体元数据"' in html,
    "video information popover": 'class="video-status-panel"' in html and 'toggleVideoStatusPanel' in html,
    "controls visibility sync": 'video-controls-visible' in html and 'scheduleVideoChromeHide' in html,
    "shared media view toggle": 'toggleMediaResourceView' in html and 'media-view-toggle' in html,
    "poster and list renderers": 'media-poster-grid' in html and 'renderMoviePoster' in html,
}
failed = [name for name, ok in checks.items() if not ok]
assert not failed, "missing: " + ", ".join(failed)
print("PASS: brand, adaptive video overlay, status popover, and media view toggle are present")
