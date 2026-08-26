#!/usr/bin/env python3
import json, os, subprocess, time, urllib.request
from pathlib import Path

OUT=Path('/opt/data/vaulthub-phase0-baseline.json')
container=os.environ.get('VAULTHUB_CONTAINER','VaultHub')
def sh(*args):
    return subprocess.check_output(args,text=True,stderr=subprocess.STDOUT).strip()
def docker_exec(cmd):
    return sh('docker','exec',container,'sh','-c',cmd)
def curl_time(url):
    endpoint=url.replace('http://127.0.0.1:8088','http://127.0.0.1:8088')
    out=docker_exec("curl -sS -o /dev/null -w '%{http_code} %{time_total}' "+endpoint)
    code,t=out.split(); return {'http':int(code),'seconds':float(t)}
def sample(cmd,n=5,interval=.4):
    vals=[]
    for i in range(n):
        try: vals.append(docker_exec(cmd))
        except Exception as e: vals.append('ERROR '+str(e))
        if i+1<n: time.sleep(interval)
    return vals

data: dict[str, object]={'timestamp':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'container':container}
data['docker_inspect']=sh('docker','inspect',container,'--format','{{json .}}')
data['startup_rss_kb']=docker_exec("awk '/VmRSS/{print $2}' /proc/1/status")
data['idle_cpu_samples']=sample("awk '/cpu /{print $2+$4+$5,$2+$4+$5+$6+$7+$8+$9+$10}' /proc/stat")
data['endpoint_timings']={
 'healthz':curl_time('http://127.0.0.1:8088/healthz'),
 'media_libraries':curl_time('http://127.0.0.1:8088/api/media/libraries'),
 'home':curl_time('http://127.0.0.1:8088/'),
}
data['process_samples']=sample("ps -eo pid,comm,%cpu,%mem,rss,args --no-headers | grep -E '(vaulthub-manager|media-api|subtitle-api|caddy)' | grep -v grep || true")
data['notes']=['首页加载时间使用本机到容器映射端口的 curl 首字节总耗时；浏览器视觉加载需另行测量。','1万文件扫描、FFprobe、首帧及1/2路并播需使用真实媒体库与视频样本，当前脚本不伪造缺失数据。']
OUT.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'output':str(OUT),'endpoint_timings':data['endpoint_timings'],'startup_rss_kb':data['startup_rss_kb']},ensure_ascii=False,indent=2))
