package main

import (
	"context"
	"strings"
	"testing"
)

func TestCompatArgsFollowPlaybackMode(t *testing.T) {
	oldProbe := probeVideoCodec
	defer func() { probeVideoCodec = oldProbe }()
	probeVideoCodec = func(context.Context, string) (string, error) { return "h264", nil }

	_, remux := compatArgs(context.Background(), "movie.mkv", "", "cpu", "remux")
	joined := strings.Join(remux, " ")
	if !strings.Contains(joined, "-c:v copy") || !strings.Contains(joined, "-c:a copy") {
		t.Fatalf("remux must copy both streams: %s", joined)
	}

	_, audio := compatArgs(context.Background(), "movie.mkv", "", "cpu", "audio_transcode")
	joined = strings.Join(audio, " ")
	if !strings.Contains(joined, "-c:v copy") || !strings.Contains(joined, "-c:a aac") {
		t.Fatalf("audio transcode must copy video and encode AAC: %s", joined)
	}
}
