package main

import (
	"testing"
)

func TestV0953ItunesPickMatchesTitleAndArtist(t *testing.T) {
	tracks := []itunesTrack{
		{TrackName: "青花瓷", ArtistName: "周杰倫", CollectionName: "我很忙", ArtworkURL100: "https://is1-ssl.mzstatic.com/source/100x100bb.jpg"},
		{TrackName: "青花瓷 (Live)", ArtistName: "周杰倫", CollectionName: "地表最強", ArtworkURL100: ""},
	}
	out, ok := itunesPick("青花瓷", "周杰伦", tracks)
	if !ok {
		t.Fatal("expected iTunes match")
	}
	if out.Provider != "iTunes" || out.Title != "青花瓷" || out.Album != "我很忙" {
		t.Fatalf("unexpected result: %+v", out)
	}
	if out.Cover != "https://is1-ssl.mzstatic.com/source/600x600bb.jpg" {
		t.Fatalf("cover not upgraded to 600x600: %s", out.Cover)
	}
}

func TestV0953ItunesPickRequiresTitleCloseness(t *testing.T) {
	tracks := []itunesTrack{
		{TrackName: "完全无关的歌", ArtistName: "别人", CollectionName: "别的专辑"},
	}
	if _, ok := itunesPick("青花瓷", "周杰伦", tracks); ok {
		t.Fatal("unrelated iTunes track accepted")
	}
}

func TestV0953ItunesPickUnknownArtistAllowsTitleExact(t *testing.T) {
	tracks := []itunesTrack{
		{TrackName: "Seven Nation Army", ArtistName: "The White Stripes", CollectionName: "Elephant"},
	}
	out, ok := itunesPick("Seven Nation Army", "未知歌手", tracks)
	if !ok || out.Title != "Seven Nation Army" || out.Provider != "iTunes" {
		t.Fatalf("unexpected: %+v ok=%v", out, ok)
	}
}

func TestV0953AudioHiResArtwork(t *testing.T) {
	cases := map[string]string{
		"https://x/a/100x100bb.jpg":  "https://x/a/600x600bb.jpg",
		"https://x/b/100x100-2x.jpg": "https://x/b/100x100-2x.jpg",
	}
	for in, want := range cases {
		if got := audioHiResArtwork(in); got != want {
			t.Fatalf("audioHiResArtwork(%q)=%q want %q", in, got, want)
		}
	}
}
