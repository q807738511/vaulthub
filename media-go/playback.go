package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

var probePlaybackMedia = func(ctx context.Context, path string) (playbackMedia, error) {
	b, err := exec.CommandContext(ctx, "ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", path).Output()
	if err != nil {
		return playbackMedia{}, err
	}
	var raw struct {
		Streams []struct {
			CodecType string `json:"codec_type"`
			CodecName string `json:"codec_name"`
			Width     int    `json:"width"`
			Height    int    `json:"height"`
		} `json:"streams"`
		Format struct {
			FormatName string `json:"format_name"`
			BitRate    string `json:"bit_rate"`
			Duration   string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return playbackMedia{}, err
	}
	m := playbackMedia{BitRate: raw.Format.BitRate, Duration: raw.Format.Duration}
	for _, s := range raw.Streams {
		if s.CodecType == "video" && m.VideoCodec == "" {
			m.VideoCodec = s.CodecName
			m.Width = s.Width
			m.Height = s.Height
		}
		if s.CodecType == "audio" && m.AudioCodec == "" {
			m.AudioCodec = s.CodecName
		}
	}
	ext := strings.ToLower(filepath.Ext(path))
	m.Container = strings.TrimPrefix(ext, ".")
	if m.Container == "" {
		m.Container = strings.Split(raw.Format.FormatName, ",")[0]
	}
	return m, nil
}

// qualityMaxHeight maps a UI quality choice to a vertical pixel cap.
// "auto" and "original" impose no cap; an explicit 1080p/720p/480p choice does.
// v0.9.50: the floating player's 设置 → 转码质量 selector sends these values.
func qualityMaxHeight(quality string) int {
	switch strings.ToLower(strings.TrimSpace(quality)) {
	case "1080p":
		return 1080
	case "720p":
		return 720
	case "480p":
		return 480
	}
	return 0
}

func choosePlaybackPlan(m playbackMedia, c playbackClient, quality, hardware string) playbackPlan {
	if quality == "" {
		quality = "auto"
	}
	videoOK := (m.VideoCodec == "h264" && c.H264) || (m.VideoCodec == "hevc" && c.HEVC) || ((m.VideoCodec == "vp9" || m.VideoCodec == "vp09") && c.VP9)
	audioOK := m.AudioCodec == "" || (m.AudioCodec == "aac" && c.AAC) || (m.AudioCodec == "opus" && c.Opus) || m.AudioCodec == "mp3"
	containerOK := (m.Container == "mp4" || m.Container == "m4v") && c.MP4
	plan := playbackPlan{Media: m, Hardware: hardware, VideoAction: "copy", AudioAction: "copy"}
	// An explicit resolution cap always wins: the point of picking 720p is to
	// stop shipping the 4K original, so a compatible source must still be
	// re-encoded. Sources already at or below the cap are never upscaled.
	if cap := qualityMaxHeight(quality); cap > 0 {
		if m.Height == 0 || m.Height > cap {
			plan.Layer, plan.Mode = "smart_stream", "full_transcode"
			plan.Reason = fmt.Sprintf("按所选画质限制到 %dp，转换为 H.264/AAC", cap)
			plan.VideoAction, plan.AudioAction = "h264", "aac"
			plan.MaxHeight = cap
			return plan
		}
		// Source already fits the cap: fall through to the normal decision as if
		// the user had chosen 自动, so a 720p file under a 1080p cap still gets
		// direct play instead of a pointless remux.
		quality = "auto"
	}
	switch {
	case quality == "original" && containerOK && videoOK && audioOK:
		plan.Layer, plan.Mode, plan.Reason = "direct_play", "direct", "原画模式：浏览器支持当前封装、视频和音频编码"
	case quality == "auto" && containerOK && videoOK && audioOK:
		plan.Layer, plan.Mode, plan.Reason = "direct_play", "direct", "浏览器支持当前封装、视频和音频编码"
	case videoOK && audioOK:
		plan.Layer, plan.Mode, plan.Reason = "smart_stream", "remux", "浏览器支持音视频编码，仅转换容器封装"
	case videoOK:
		plan.Layer, plan.Mode, plan.Reason = "smart_stream", "audio_transcode", "视频可直接复制，音频转换为 AAC"
	default:
		plan.Layer, plan.Mode, plan.Reason = "smart_stream", "full_transcode", "视频编码不兼容，转换为 H.264/AAC"
		plan.VideoAction, plan.AudioAction = "h264", "aac"
	}
	if plan.Mode == "audio_transcode" {
		plan.AudioAction = "aac"
	}
	return plan
}

/*
==================== v0.9.77：测速辅助视频自动画质 ====================

	当日首次打开 WEBUI 会做一次网络测速（前端），把实测下行带宽随播放计划一起上传。
	自动档下按带宽给「上限」：超出的源走一次限高转码，避免弱网/远程直接拖 4K 原片。
	  < 2 Mbps  → 480p
	  < 6 Mbps  → 720p
	  < 16 Mbps → 1080p
	  ≥ 16 Mbps 或未测速、或用户显式选了画质 → 不设上限（保持原判）
	只在「自动」档生效：显式 720p/1080p/original 永远按用户选择执行。
*/
func autoQualityCapForBandwidth(bps int64) int {
	switch {
	case bps <= 0:
		return 0
	case bps < 2*1000*1000:
		return 480
	case bps < 6*1000*1000:
		return 720
	case bps < 16*1000*1000:
		return 1080
	default:
		return 0
	}
}

func applyNetworkCap(plan playbackPlan, quality string, networkBps int64) playbackPlan {
	if quality != "" && quality != "auto" {
		return plan
	}
	capHeight := autoQualityCapForBandwidth(networkBps)
	if capHeight <= 0 || plan.Media.Height == 0 || plan.Media.Height <= capHeight {
		return plan
	}
	if plan.MaxHeight > 0 && plan.MaxHeight <= capHeight {
		return plan
	}
	plan.Layer, plan.Mode = "smart_stream", "full_transcode"
	plan.VideoAction, plan.AudioAction = "h264", "aac"
	plan.MaxHeight = capHeight
	plan.Reason = fmt.Sprintf("测速 %.1f Mbps：自动限制到 %dp，转换为 H.264/AAC", float64(networkBps)/1000/1000, capHeight)
	return plan
}

func (a *App) playbackPlan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !writeAuth(r) {
		errJSON(w, http.StatusUnauthorized, "login required")
		return
	}
	var req struct {
		LibraryID string `json:"library_id"`
		Path      string `json:"path"`
		Quality   string `json:"quality"`
		Hardware  string `json:"hardware"`
		/* v0.9.77：当天测速得到的下行带宽（bit/s），仅用于自动档限高。 */
		NetworkBps int64          `json:"network_bps"`
		Client     playbackClient `json:"client"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req) != nil {
		errJSON(w, 400, "invalid playback request")
		return
	}
	lib, ok := a.find(req.LibraryID)
	if !ok {
		errJSON(w, 404, "invalid media path")
		return
	}
	p, _, err := safeFile(lib, req.Path)
	if err != nil {
		errJSON(w, 404, "invalid media path")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	media, err := probePlaybackMedia(ctx, p)
	if err != nil {
		errJSON(w, 422, "media probe failed")
		return
	}
	hwInfo := detectHardware(ctx, req.Hardware)
	selected, _ := hwInfo["selected"].(string)
	plan := choosePlaybackPlan(media, req.Client, req.Quality, selected)
	plan = applyNetworkCap(plan, req.Quality, req.NetworkBps)
	q := url.Values{"id": {lib.ID}, "path": {req.Path}}
	if plan.Mode == "direct" {
		plan.URL = "/api/media/file?" + q.Encode()
	} else {
		q.Set("hw", selected)
		q.Set("mode", plan.Mode)
		if plan.MaxHeight > 0 {
			q.Set("height", strconv.Itoa(plan.MaxHeight))
		}
		plan.URL = "/api/media/compat?" + q.Encode()
	}
	writeJSON(w, 200, plan)
}

func randomPlaybackID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("p-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func (a *App) playbackSessionsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		errJSON(w, 405, "method not allowed")
		return
	}
	if !writeAuth(r) {
		errJSON(w, http.StatusUnauthorized, "login required")
		return
	}
	var s playbackSession
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&s) != nil || s.LibraryID == "" || s.Path == "" {
		errJSON(w, 400, "invalid session")
		return
	}
	lib, ok := a.find(s.LibraryID)
	if !ok {
		errJSON(w, 404, "invalid media path")
		return
	}
	if _, _, err := safeFile(lib, s.Path); err != nil {
		errJSON(w, 404, "invalid media path")
		return
	}
	s.ID = randomPlaybackID()
	s.State = "playing"
	s.UpdatedAt = time.Now().UnixMilli()
	a.mu.Lock()
	if a.playbackSessions == nil {
		a.playbackSessions = map[string]playbackSession{}
	}
	cutoff := time.Now().Add(-2 * time.Minute).UnixMilli()
	for id, existing := range a.playbackSessions {
		if existing.UpdatedAt < cutoff {
			delete(a.playbackSessions, id)
			if cancel := a.tasks[id]; cancel != nil {
				cancel()
				delete(a.tasks, id)
			}
		}
	}
	if len(a.playbackSessions) >= 64 {
		a.mu.Unlock()
		errJSON(w, http.StatusTooManyRequests, "too many playback sessions")
		return
	}
	a.playbackSessions[s.ID] = s
	a.mu.Unlock()
	writeJSON(w, 200, s)
}

func (a *App) playbackSessionAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		errJSON(w, 405, "method not allowed")
		return
	}
	if !writeAuth(r) {
		errJSON(w, http.StatusUnauthorized, "login required")
		return
	}
	rel := strings.TrimPrefix(r.URL.Path, "/api/media/playback/sessions/")
	parts := strings.Split(strings.Trim(rel, "/"), "/")
	if len(parts) != 2 {
		errJSON(w, 404, "session not found")
		return
	}
	id, action := parts[0], parts[1]
	a.mu.Lock()
	defer a.mu.Unlock()
	s, ok := a.playbackSessions[id]
	if !ok {
		errJSON(w, 404, "session not found")
		return
	}
	if action == "stop" {
		delete(a.playbackSessions, id)
		if cancel, ok := a.tasks[id]; ok {
			cancel()
			delete(a.tasks, id)
		}
		writeJSON(w, 200, map[string]any{"ok": true})
		return
	}
	if action != "progress" {
		errJSON(w, 404, "session action not found")
		return
	}
	var p struct {
		PositionMS int64  `json:"position_ms"`
		DurationMS int64  `json:"duration_ms"`
		State      string `json:"state"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&p) != nil {
		errJSON(w, 400, "invalid progress")
		return
	}
	s.PositionMS = p.PositionMS
	s.DurationMS = p.DurationMS
	if p.State != "" {
		s.State = p.State
	}
	s.UpdatedAt = time.Now().UnixMilli()
	a.playbackSessions[id] = s
	writeJSON(w, 200, s)
}
