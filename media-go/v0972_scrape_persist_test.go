package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func newV0972App(t *testing.T) (*App, string) {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "song.mp3"), []byte("ID3fixture"), 0o644); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", "file::memory:?cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err = db.Exec(`CREATE TABLE files(lib TEXT,path TEXT,size INTEGER,mtime INTEGER,PRIMARY KEY(lib,path))`); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Join(root, "song.mp3"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO files VALUES('music','song.mp3',?,?)`, fi.Size(), fi.ModTime().Unix()); err != nil {
		t.Fatal(err)
	}
	a := &App{libs: []Library{{ID: "music", Name: "Music", Type: "audio", Path: root}}, db: db}
	return a, root
}

func TestV0972SidecarAtomicAndUserOwnedRefused(t *testing.T) {
	_, root := newV0972App(t)
	abs := filepath.Join(root, "song.mp3")
	in := audioPersistedMetadata{Title: "夜に駆ける", Artist: "YOASOBI", Status: "manual"}
	out, err := writeAudioMetadataSidecar(abs, in)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(out)
	if !bytes.Contains(b, []byte(`"generated_by": "VaultHub"`)) || !bytes.Contains(b, []byte("夜に駆ける")) {
		t.Fatalf("bad sidecar %s", b)
	}
	if matches, _ := filepath.Glob(filepath.Join(root, ".vaulthub-meta-*.tmp")); len(matches) != 0 {
		t.Fatalf("tmp leaked %v", matches)
	}
	if err = os.WriteFile(out, []byte(`{"generated_by":"user"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err = writeAudioMetadataSidecar(abs, in); err == nil {
		t.Fatal("must not overwrite user-owned sidecar")
	}
}

func TestV0972CommitPersistsAndStatusTruthful(t *testing.T) {
	a, root := newV0972App(t)
	invalidateAudioScrapeStatus("music")
	old := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { managerSessionOK = old }()
	body := map[string]any{"id": "music", "path": "song.mp3", "title": "残酷な天使のテーゼ", "artist": "高橋洋子", "album": "EP", "provider": "manual", "status": "manual", "query_title": "残酷な天使のテーゼ", "query_artist": "高橋洋子", "country": "JP", "source": "iTunes", "lock_title": true}
	raw, _ := json.Marshal(body)
	rec := httptest.NewRecorder()
	a.audioMetadataCommit(rec, httptest.NewRequest(http.MethodPost, "/api/media/audio/metadata/commit", bytes.NewReader(raw)))
	if rec.Code != 200 {
		t.Fatalf("commit=%d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "song.vaulthub.json")); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	a.audioScrapeStatus(rec, httptest.NewRequest(http.MethodGet, "/api/media/audio/scrape/status?id=music", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"manual":1`) {
		t.Fatalf("status=%d %s", rec.Code, rec.Body.String())
	}
}

func TestV0972StatusIgnoresStaleOrReplacedFiles(t *testing.T) {
	a, root := newV0972App(t)
	invalidateAudioScrapeStatus("music")
	old := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { managerSessionOK = old }()
	if err := a.ensureAudioCacheTable(); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec(`INSERT OR REPLACE INTO audio_metadata
(lib,path,size,mtime,title,artist,album,cover,lyrics,lyrics_source,provider,checked_at,status,error_code,query_title,query_artist,country,source,lock_title,lock_artist,lock_album,lock_cover,lock_lyrics,persisted)
VALUES('music','song.mp3',999,999,'old','','','','','','manual',1,'manual','','','','AUTO','manual',0,0,0,0,0,1)`); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	a.audioScrapeStatus(rec, httptest.NewRequest(http.MethodGet, "/api/media/audio/scrape/status?id=music", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"manual":0`) || !strings.Contains(rec.Body.String(), `"pending":1`) {
		t.Fatalf("stale status must stay pending: %d %s", rec.Code, rec.Body.String())
	}
	// 反向：元数据与磁盘一致时必须如实计入完成。
	fi, err := os.Stat(filepath.Join(root, "song.mp3"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Exec(`UPDATE audio_metadata SET size=?, mtime=? WHERE lib='music' AND path='song.mp3'`, fi.Size(), fi.ModTime().Unix()); err != nil {
		t.Fatal(err)
	}
	invalidateAudioScrapeStatus("music") // 测试直接改库，模拟外部写入后必须重新统计
	rec = httptest.NewRecorder()
	a.audioScrapeStatus(rec, httptest.NewRequest(http.MethodGet, "/api/media/audio/scrape/status?id=music", nil))
	if !strings.Contains(rec.Body.String(), `"manual":1`) || !strings.Contains(rec.Body.String(), `"complete":1`) {
		t.Fatalf("fresh metadata must count as complete: %s", rec.Body.String())
	}
}

// 索引表可能落后于磁盘：源文件在磁盘上被改写但尚未重扫时，旧结果必须立刻失效。
func TestV0972StatusDetectsOnDiskChangeWithoutRescan(t *testing.T) {
	a, root := newV0972App(t)
	invalidateAudioScrapeStatus("music")
	old := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { managerSessionOK = old }()
	if err := a.ensureAudioCacheTable(); err != nil {
		t.Fatal(err)
	}
	song := filepath.Join(root, "song.mp3")
	fi, err := os.Stat(song)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Exec(`INSERT OR REPLACE INTO audio_metadata
(lib,path,size,mtime,title,status,provider,checked_at,country,source)
VALUES('music','song.mp3',?,?,'t','succeeded','iTunes',1,'AUTO','auto')`, fi.Size(), fi.ModTime().Unix()); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(song, []byte("ID3-replaced-and-longer-payload"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err = os.Chtimes(song, fi.ModTime().Add(3*time.Second), fi.ModTime().Add(3*time.Second)); err != nil {
		t.Fatal(err)
	}
	fi2, err := os.Stat(song)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	a.audioScrapeStatus(rec, httptest.NewRequest(http.MethodGet, "/api/media/audio/scrape/status?id=music", nil))
	if !strings.Contains(rec.Body.String(), `"succeeded":0`) || !strings.Contains(rec.Body.String(), `"pending":1`) {
		t.Fatalf("on-disk change must invalidate without rescan: %s", rec.Body.String())
	}
	rec = httptest.NewRecorder()
	a.audioCache(rec, httptest.NewRequest(http.MethodGet, "/api/media/audio/cache?id=music", nil))
	if !strings.Contains(rec.Body.String(), `"count":0`) || !strings.Contains(rec.Body.String(), `"scan_errors":0`) {
		t.Fatalf("cache read must drop entries whose file changed on disk (and never silently drop rows): %s", rec.Body.String())
	}
	// 同一条记录在磁盘与库一致时必须能读回，且 NULL 列不会让整行被丢掉。
	if _, err = a.db.Exec(`UPDATE audio_metadata SET size=?, mtime=? WHERE lib='music' AND path='song.mp3'`, fi2.Size(), fi2.ModTime().Unix()); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	a.audioCache(rec, httptest.NewRequest(http.MethodGet, "/api/media/audio/cache?id=music", nil))
	if !strings.Contains(rec.Body.String(), `"count":1`) || !strings.Contains(rec.Body.String(), `"scan_errors":0`) {
		t.Fatalf("matching entry must be readable: %s", rec.Body.String())
	}
}

func TestV0972CacheReadKeepsFreshEntry(t *testing.T) {
	a, root := newV0972App(t)
	invalidateAudioScrapeStatus("music")
	old := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { managerSessionOK = old }()
	body := map[string]any{"id": "music", "path": "song.mp3", "title": "残酷な天使のテーゼ", "status": "manual",
		"artist": "高橋洋子", "provider": "manual", "query_title": "A Cruel Angel's Thesis", "country": "JP",
		"source": "iTunes", "lock_title": true}
	raw, _ := json.Marshal(body)
	rec := httptest.NewRecorder()
	a.audioMetadataCommit(rec, httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(raw)))
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "song.vaulthub.json")); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	a.audioCache(rec, httptest.NewRequest(http.MethodGet, "/api/media/audio/cache?id=music", nil))
	out := rec.Body.String()
	if !strings.Contains(out, `"count":1`) || !strings.Contains(out, "A Cruel Angel's Thesis") || !strings.Contains(out, `"lock_title":true`) {
		t.Fatalf("fresh entry must be returned with correction fields: %s", out)
	}
}

func TestV0972ConcurrentSidecarUpdatesRemainValid(t *testing.T) {
	_, root := newV0972App(t)
	abs := filepath.Join(root, "song.mp3")
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := writeAudioMetadataSidecar(abs, audioPersistedMetadata{Title: fmt.Sprintf("track-%d", i), Status: "manual"})
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent sidecar write failed: %v", err)
		}
	}
	var got audioPersistedMetadata
	data, err := os.ReadFile(audioMetadataSidecar(abs))
	if err != nil || json.Unmarshal(data, &got) != nil || got.GeneratedBy != "VaultHub" || got.Title == "" {
		t.Fatalf("invalid concurrent sidecar: err=%v data=%s", err, data)
	}
}

func TestV0972LegacyCacheWritePreservesCorrectionFields(t *testing.T) {
	a, _ := newV0972App(t)
	oldSession := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { managerSessionOK = oldSession }()
	first := `{"id":"music","path":"song.mp3","title":"T","status":"manual","query_title":"Q","country":"JP","source":"iTunes","lock_title":true}`
	rec := httptest.NewRecorder()
	a.audioMetadataCommit(rec, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(first)))
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	legacy := `{"path":"song.mp3","title":"T2","provider":"manual"}`
	rec = httptest.NewRecorder()
	a.audioCache(rec, httptest.NewRequest(http.MethodPost, "/?id=music", strings.NewReader(legacy)))
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	var query, country, source, status string
	var lock bool
	if err := a.db.QueryRow(`SELECT query_title,country,source,status,lock_title FROM audio_metadata WHERE lib='music' AND path='song.mp3'`).Scan(&query, &country, &source, &status, &lock); err != nil {
		t.Fatal(err)
	}
	if query != "Q" || country != "JP" || source != "iTunes" || status != "manual" || !lock {
		t.Fatalf("legacy write erased correction fields: query=%q country=%q source=%q status=%q lock=%v", query, country, source, status, lock)
	}
}

// 状态快照必须既省 stat、又在写入后立即失效。
func TestV0972StatusSnapshotHonoursTTLAndInvalidation(t *testing.T) {
	a, root := newV0972App(t)
	invalidateAudioScrapeStatus("music")
	old := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { managerSessionOK = old }()
	if err := a.ensureAudioCacheTable(); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Join(root, "song.mp3"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Exec(`INSERT OR REPLACE INTO audio_metadata
(lib,path,size,mtime,title,status,provider,checked_at,country,source)
VALUES('music','song.mp3',?,?,'t','succeeded','iTunes',1,'AUTO','auto')`, fi.Size(), fi.ModTime().Unix()); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	a.audioScrapeStatus(rec, httptest.NewRequest(http.MethodGet, "/api/media/audio/scrape/status?id=music", nil))
	if !strings.Contains(rec.Body.String(), `"succeeded":1`) {
		t.Fatalf("baseline status wrong: %s", rec.Body.String())
	}
	// 直接改库（不经过写入入口）→ TTL 内仍返回快照，避免每个 5 秒轮询都全量 stat。
	if _, err = a.db.Exec(`UPDATE audio_metadata SET size=999, mtime=999 WHERE lib='music' AND path='song.mp3'`); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	a.audioScrapeStatus(rec, httptest.NewRequest(http.MethodGet, "/api/media/audio/scrape/status?id=music", nil))
	if !strings.Contains(rec.Body.String(), `"succeeded":1`) {
		t.Fatalf("snapshot TTL not honoured: %s", rec.Body.String())
	}
	// TTL 到期后必须重新统计（否则磁盘变化在无写入时永远看不到）。
	oldTTL := audioScrapeStatusTTL
	shortTTL := 60 * time.Millisecond
	audioScrapeStatusTTL = shortTTL
	// 先把库里的值改回与磁盘一致，再让状态在短 TTL 下缓存一次。
	if _, err = a.db.Exec(`UPDATE audio_metadata SET size=?, mtime=? WHERE lib='music' AND path='song.mp3'`, fi.Size(), fi.ModTime().Unix()); err != nil {
		t.Fatal(err)
	}
	invalidateAudioScrapeStatus("music")
	rec = httptest.NewRecorder()
	a.audioScrapeStatus(rec, httptest.NewRequest(http.MethodGet, "/api/media/audio/scrape/status?id=music", nil))
	if !strings.Contains(rec.Body.String(), `"succeeded":1`) {
		t.Fatalf("expected fresh snapshot: %s", rec.Body.String())
	}
	// 无写入地改库 + 等过快照有效期 → 必须重新计算。
	if _, err = a.db.Exec(`UPDATE audio_metadata SET size=999, mtime=999 WHERE lib='music' AND path='song.mp3'`); err != nil {
		t.Fatal(err)
	}
	time.Sleep(shortTTL * 2)
	rec = httptest.NewRecorder()
	a.audioScrapeStatus(rec, httptest.NewRequest(http.MethodGet, "/api/media/audio/scrape/status?id=music", nil))
	audioScrapeStatusTTL = oldTTL
	if !strings.Contains(rec.Body.String(), `"succeeded":0`) || !strings.Contains(rec.Body.String(), `"pending":1`) {
		t.Fatalf("expired snapshot not recomputed: %s", rec.Body.String())
	}
	invalidateAudioScrapeStatus("music")
	rec = httptest.NewRecorder()
	a.audioScrapeStatus(rec, httptest.NewRequest(http.MethodGet, "/api/media/audio/scrape/status?id=music", nil))
	if !strings.Contains(rec.Body.String(), `"succeeded":0`) || !strings.Contains(rec.Body.String(), `"pending":1`) {
		t.Fatalf("invalidation did not refresh status: %s", rec.Body.String())
	}
	// 旧缓存写入口必须让快照失效：重新按磁盘写入后状态应立刻恢复为成功。
	legacy := `{"path":"song.mp3","title":"t","provider":"iTunes","artist":"a","album":"b"}`
	rec = httptest.NewRecorder()
	a.audioCache(rec, httptest.NewRequest(http.MethodPost, "/?id=music", strings.NewReader(legacy)))
	if rec.Code != 200 {
		t.Fatalf("legacy write failed: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	a.audioScrapeStatus(rec, httptest.NewRequest(http.MethodGet, "/api/media/audio/scrape/status?id=music", nil))
	if !strings.Contains(rec.Body.String(), `"succeeded":1`) {
		t.Fatalf("legacy write did not invalidate snapshot: %s", rec.Body.String())
	}
	// 删除入口同样必须让快照失效（否则会继续显示已完成的旧数据）。
	rec = httptest.NewRecorder()
	a.audioCache(rec, httptest.NewRequest(http.MethodDelete, "/?id=music&all=1", nil))
	if rec.Code != 200 {
		t.Fatalf("delete failed: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	a.audioScrapeStatus(rec, httptest.NewRequest(http.MethodGet, "/api/media/audio/scrape/status?id=music", nil))
	if !strings.Contains(rec.Body.String(), `"pending":1`) || !strings.Contains(rec.Body.String(), `"succeeded":0`) {
		t.Fatalf("delete did not invalidate snapshot: %s", rec.Body.String())
	}
}

func TestV0972InvalidStateCountryAndTraversalRejected(t *testing.T) {
	a, _ := newV0972App(t)
	old := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { managerSessionOK = old }()
	for _, body := range []string{`{"id":"music","path":"../x.mp3","status":"manual"}`, `{"id":"music","path":"song.mp3","status":"done"}`, `{"id":"music","path":"song.mp3","status":"manual","country":"CN"}`} {
		rec := httptest.NewRecorder()
		a.audioMetadataCommit(rec, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body)))
		if rec.Code < 400 {
			t.Fatalf("accepted %s => %d", body, rec.Code)
		}
	}
}

func TestV0972BoundedFFmpegError(t *testing.T) {
	var b boundedErrorBuffer
	payload := bytes.Repeat([]byte("x"), ffmpegErrorLimit*2)
	n, err := b.Write(payload)
	if err != nil || n != len(payload) || len(b.String()) != ffmpegErrorLimit {
		t.Fatalf("n=%d size=%d err=%v", n, len(b.String()), err)
	}
}
