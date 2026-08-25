#!/usr/bin/env python3
from pathlib import Path
p=Path(__file__).resolve().parents[1]/'index.html'
s=p.read_text()
checks={
 'responsive sidebar toggle':'@media (max-width: 768px)' in s and 'toggleBars()' in s and 'sidebar-hidden' in s,
 'video status element':'data-video-status' in s,
 'video status events':'waiting' in s and 'timeupdate' in s and 'loadedmetadata' in s,
 'docker scan input':'dockerServerIp' in s and 'scanDockerServer()' in s,
 'docker scan endpoint':'/api/admin/docker/scan' in s,
 'hidden pt docker defaults':'module-hidden-pt' in s and 'module-hidden-docker' in s,
}
for k,v in checks.items(): assert v,k
print('PASS: responsive shell, video status, hidden modules, and Docker scan UI are present')
