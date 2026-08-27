#!/usr/bin/env python3
from pathlib import Path

import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(__file__))
from _frontend import frontend_source as _fs
html = _fs()

required = [
    'comicShelfView',
    '书架',
    '已读收藏',
    'mediaPageSize',
    '<option value="20"',
    '<option value="50"',
    '<option value="100"',
    'COMPLETED_PROGRESS = 99.9',
    'media-reader-overlay',
    'media-reader-close',
    'closeLocalViewer',
    'book-cover',
    'data-reader-scroll',
]

for marker in required:
    assert marker in html, f"missing comic reader feature: {marker}"

assert 'limit=${pageSize}' in html, "file request does not use selected page size"
assert 'offset - pageSize' in html, "previous page does not honor selected size"
assert 'offset + pageSize' in html, "next page does not honor selected size"
assert 'progress >= COMPLETED_PROGRESS' in html, "completed items are not archived at 99.9%"
assert 'setComicShelfView("shelf")' in html, "closing reader does not return to shelf"

print("PASS: comic bookshelf, pagination and immersive reader markers are present")
