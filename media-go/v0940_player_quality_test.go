package main

import (
	"context"
	"strings"
	"testing"
)

// v0.9.40: the floating player's 设置 → 转码质量 selector must actually change what
// ffmpeg produces. An explicit resolution cap has to force a real re-encode (you
// cannot scale a copied stream) and must never upscale a smaller source.

func TestQualityMaxHeight(t *testing.T) {
	cases := map[string]int{
		"":         0,
		"auto":     0,
		"original": 0,
		"1080p":    1080,
		"720p":     720,
		"480p":     480,
		" 720P ":   720,
		"nonsense": 0,
	}
	for in, want := range cases {
		if got := qualityMaxHeight(in); got != want {
			t.Fatalf("qualityMaxHeight(%q)=%d want %d", in, got, want)
		}
	}
}

func TestPlanQualityCapForcesTranscode(t *testing.T) {
	// A perfectly compatible 4K MP4 would normally be direct-played. Asking for
	// 720p must still transcode, otherwise the selector silently does nothing.
	media := playbackMedia{Container: "mp4", VideoCodec: "h264", AudioCodec: "aac", Width: 3840, Height: 2160}
	client := playbackClient{MP4: true, H264: true, AAC: true}
	plan := choosePlaybackPlan(media, client, "720p", "cpu")
	if plan.Mode != "full_transcode" || plan.MaxHeight != 720 {
		t.Fatalf("720p must force a capped transcode, got mode=%s max=%d", plan.Mode, plan.MaxHeight)
	}
	if plan.VideoAction != "h264" || plan.AudioAction != "aac" {
		t.Fatalf("capped transcode must re-encode: %+v", plan)
	}
	// Auto keeps the old behaviour: no cap, direct play.
	auto := choosePlaybackPlan(media, client, "auto", "cpu")
	if auto.Mode != "direct" || auto.MaxHeight != 0 {
		t.Fatalf("auto must stay direct without a cap: %+v", auto)
	}
	// A source already below the cap is left alone.
	small := playbackMedia{Container: "mp4", VideoCodec: "h264", AudioCodec: "aac", Width: 1280, Height: 720}
	kept := choosePlaybackPlan(small, client, "1080p", "cpu")
	if kept.Mode != "direct" || kept.MaxHeight != 0 {
		t.Fatalf("720p source under a 1080p cap must not be re-encoded: %+v", kept)
	}
}

func TestCompatArgsScaledDownscales(t *testing.T) {
	oldProbe := probeVideoCodec
	defer func() { probeVideoCodec = oldProbe }()
	probeVideoCodec = func(context.Context, string) (string, error) { return "h264", nil }

	// Without a cap an H.264 source is copied (the fast path must not regress).
	_, plain := compatArgsScaled(context.Background(), "movie.mkv", "", "cpu", "remux", 0)
	if !strings.Contains(strings.Join(plain, " "), "-c:v copy") {
		t.Fatalf("uncapped H.264 must still stream-copy: %v", plain)
	}

	// With a cap the same source must be re-encoded and scaled.
	_, capped := compatArgsScaled(context.Background(), "movie.mkv", "", "cpu", "remux", 720)
	joined := strings.Join(capped, " ")
	if strings.Contains(joined, "-c:v copy") {
		t.Fatalf("a resolution cap cannot be satisfied by stream copy: %v", capped)
	}
	if !strings.Contains(joined, "scale=-2:min(ih\\,720)") {
		t.Fatalf("missing software downscale filter: %v", capped)
	}
	// Audio must be normalised too: a capped rendition is never a pure remux.
	if !strings.Contains(joined, "-c:a aac") {
		t.Fatalf("capped rendition must encode AAC audio: %v", capped)
	}
}

func TestScaleFilterValuePerEncoder(t *testing.T) {
	if got := scaleFilterValue("h264_vaapi", 1080); !strings.HasPrefix(got, "scale_vaapi=") {
		t.Fatalf("VAAPI must use scale_vaapi, got %q", got)
	}
	if got := scaleFilterValue("libx264", 480); got != "scale=-2:min(ih\\,480)" {
		t.Fatalf("software scaler mismatch: %q", got)
	}
	if got := scaleFilterValue("libx264", 0); got != "" {
		t.Fatalf("no cap must produce no filter, got %q", got)
	}
}

func TestWithScaleFilterReplacesExistingFilter(t *testing.T) {
	// hwEncodeArgs("vaapi", dev) already passes -vf scale_vaapi=format=nv12.
	// ffmpeg honours only the LAST -vf, so appending would silently drop the
	// nv12 conversion; the helper must replace the flag instead.
	post := []string{"-vf", "scale_vaapi=format=nv12"}
	out := withScaleFilter(post, "h264_vaapi", 720)
	if n := strings.Count(strings.Join(out, " "), "-vf"); n != 1 {
		t.Fatalf("expected exactly one -vf, got %d: %v", n, out)
	}
	joined := strings.Join(out, " ")
	if !strings.Contains(joined, "h=min(ih\\,720)") || !strings.Contains(joined, "format=nv12") {
		t.Fatalf("replacement filter lost VAAPI format or cap: %v", out)
	}

	// Non-filter args (nvenc preset/cq) must survive untouched.
	keep := withScaleFilter([]string{"-preset", "p4", "-cq", "23"}, "h264_nvenc", 1080)
	joined = strings.Join(keep, " ")
	for _, want := range []string{"-preset p4", "-cq 23", "-vf scale=-2:min(ih\\,1080)"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in %v", want, keep)
		}
	}

	// No cap: args come back byte-identical.
	same := withScaleFilter([]string{"-preset", "veryfast"}, "libx264", 0)
	if strings.Join(same, " ") != "-preset veryfast" {
		t.Fatalf("uncapped call must not alter args: %v", same)
	}
}
