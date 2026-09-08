#!/usr/bin/env python3
"""Contract tests for v0.6.30.Branch-update follow-up fixes:
three-language i18n parity, the tf() placeholder helper, MusicBrainz match
validation, and re-rendering dynamic home copy on language switch."""
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
state = (ROOT / "web" / "js" / "01-state.js").read_text(encoding="utf-8")
media = (ROOT / "web" / "js" / "02-media.js").read_text(encoding="utf-8")
features = (ROOT / "web" / "js" / "03-features.js").read_text(encoding="utf-8")
home = (ROOT / "web" / "js" / "05-home.js").read_text(encoding="utf-8")
index = (ROOT / "index.html").read_text(encoding="utf-8")

# --- tf(): placeholder interpolation so dynamic copy can live in the dictionary ---
assert "function tf(key, vars)" in state, "tf() placeholder helper must exist"
assert re.search(r"replace\(/\\\{\(\\w\+\)\\\}/g", state), "tf() must substitute {name} placeholders"

# --- Every language dictionary must expose exactly the same key set. ---
NODE = """
const fs=require("fs"),vm=require("vm");
const src=fs.readFileSync(process.argv[1],"utf8");
const sb={console,document:{getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[],
  addEventListener(){},body:{classList:{toggle(){},add(){},remove(){},contains:()=>false},dataset:{}},
  documentElement:{style:{setProperty(){}}}},
  localStorage:{getItem:()=>null,setItem(){},removeItem(){},clear(){}},
  setInterval:()=>0,setTimeout:()=>0,fetch:()=>Promise.reject(new Error("x")),
  navigator:{language:"zh-CN"},location:{href:"http://x/",pathname:"/"}};
sb.window=sb; sb.globalThis=sb; vm.createContext(sb);
try{vm.runInContext(src+"\\n;globalThis.__I=typeof I18N!=='undefined'?I18N:null;"
  +"globalThis.__tf=typeof tf!=='undefined'?tf:null;",sb,{timeout:8000});}catch(e){}
const I=sb.__I, tf=sb.__tf;
if(!I){console.log("NO_I18N");process.exit(0);}
const langs=Object.keys(I), base=Object.keys(I["zh-CN"]).sort();
const out={langs,counts:{},diff:{}};
for(const l of langs){
  const k=Object.keys(I[l]).sort();
  out.counts[l]=k.length;
  out.diff[l]={miss:base.filter(x=>!k.includes(x)),extra:k.filter(x=>!base.includes(x))};
}
out.tf = tf ? tf("homeCountFmt",{items:"9",libs:3}) : null;
out.tfMissing = tf ? tf("homeCountFmt",{items:"9"}) : null;
console.log(JSON.stringify(out));
"""
proc = subprocess.run([sys.executable and "node", "-e", NODE, str(ROOT / "web" / "js" / "01-state.js")],
                      capture_output=True, text=True, timeout=90)
assert proc.returncode == 0, f"node evaluation failed: {proc.stderr[:400]}"
payload = proc.stdout.strip().splitlines()[-1]
assert payload != "NO_I18N", "I18N dictionary not found"
import json
data = json.loads(payload)

assert set(data["langs"]) == {"zh-CN", "zh-TW", "en"}, f"unexpected languages: {data['langs']}"
for lang, d in data["diff"].items():
    assert not d["miss"], f"{lang} is missing keys: {d['miss'][:8]}"
    assert not d["extra"], f"{lang} has stray keys: {d['extra'][:8]}"
counts = set(data["counts"].values())
assert len(counts) == 1, f"language key counts differ: {data['counts']}"

# tf() actually interpolates, and leaves unknown placeholders visible.
assert data["tf"] == "共 9 项 · 3 个媒体库", f"tf() interpolation wrong: {data['tf']!r}"
assert "{libs}" in data["tfMissing"], "tf() must leave missing placeholders in place"

# --- Removed module must not linger in any dictionary. ---
assert "navDocker" not in state, "navDocker key must be gone along with the Docker module"

# --- Dynamic home copy must come from the dictionary, not inline literals. ---
assert "HOME_GROUP_LABEL" not in home, "hardcoded group labels must be replaced by homeGroupLabel()"
assert "const homeGroupLabel" in home, "homeGroupLabel() must resolve labels via t()"
for key in ["homeCountFmt", "libCountFmt", "homeEmptyLib", "homeLoading", "homeNoIndexed",
            "stateWait", "stateScraping", "stateDone", "actRescan"]:
    assert key in home, f"05-home.js must use i18n key {key}"
assert 'mediaTypeName' in media and '"type" + String(type)' in media, \
    "mediaTypeName() must resolve subtype names via i18n keys"

# --- setLang must re-render the JS-generated home copy. ---
set_lang = features[features.index("function setLang("):]
set_lang = set_lang[:set_lang.index("\n}") + 2]
for call in ["renderHomeLibraryNav", "renderHomeLibTable", "renderHomeCount",
             "syncHomeLibTypes", "renderHomeRecent", "renderNowPlaying", "refreshHardwareStatus"]:
    assert call in set_lang, f"setLang() must re-render {call}"

# --- MusicBrainz results must be validated by the authenticated backend. ---
audio_go = (ROOT / "media-go" / "audio_metadata.go").read_text(encoding="utf-8")
assert "score < 88" in audio_go, "a minimum score threshold must guard MusicBrainz matches"
assert "func audioCandidateMatches(" in audio_go, "backend match validation helper must exist"
assert 'recording:\"' in audio_go and 'artist:\"' in audio_go, "must use a structured MusicBrainz query"
assert "audioCandidateMatches(title, artist" in audio_go, "backend must reject unreliable candidates"
assert "recordings?.[0]" not in media, "unconditional recordings[0] adoption must be gone"

# --- Static markup keys added for previously hardcoded copy. ---
for key in ["nowBadge", "hwAuto", "hwCpu", "hwVaapi", "hwQsv", "hwCuda"]:
    assert f'data-i18n="{key}"' in index, f"index.html must tag {key} with data-i18n"
assert "hwBadgeFmt" in state and "hwBadgeFail" in state, "hardware badge copy must be translatable"
assert "diskFreeShort" in state and "noVolumes" in state, "disk row copy must be translatable"
assert 'curLang === "en" ? "No configured volumes"' not in features, \
    "inline language branch must be replaced by a dictionary key"

print("PASS: i18n parity, tf() interpolation, MusicBrainz validation, and setLang re-render are in place")
