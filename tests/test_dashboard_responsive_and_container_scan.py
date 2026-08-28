#!/usr/bin/env python3
from pathlib import Path
p=Path(__file__).resolve().parents[1]/'index.html'
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(__file__))
from _frontend import frontend_source as _fs
s=_fs()
checks={
 'responsive sidebar toggle':'@media (max-width: 768px)' in s and 'toggleBars()' in s and 'sidebar-hidden' in s,
 'video status element':'data-video-status' in s,
 'video status events':'waiting' in s and 'timeupdate' in s and 'loadedmetadata' in s,
 # v0.6.30.Branch-update removed 容器管理 (Docker scan) entirely: the view, the
 # renderer, the #dockerSearch listener and the module entry are all gone, so
 # the UI must no longer reference any of it. Leaving dead hooks behind would
 # throw a null reference at load and kill the whole script.
 'docker scan UI removed':'dockerServerIp' not in s and 'scanDockerServer' not in s,
 'docker module entry removed':'module-hidden-docker' not in s and 'view-docker' not in s,
 'hidden pt default kept':'module-hidden-pt' in s,
}
for k,v in checks.items(): assert v,k
print('PASS: responsive shell, video status, hidden modules, and Docker removal are consistent')
