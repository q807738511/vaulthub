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
# v0.9.73：关闭阅读器不再强制跳回「未读」视图 —— 用户常从「历史阅读」点开一本书，
# 关掉就被踢回未读，看起来正像这本书被释放出了历史列表（用户报告的缺陷）。
# 现在保持当前视图并重渲染（setComicShelfView(comicShelfView)）。
assert 'setComicShelfView(comicShelfView)' in html, "closing reader must keep the current shelf view"

print("PASS: comic bookshelf, pagination and immersive reader markers are present")
