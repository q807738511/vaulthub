#!/usr/bin/env python3
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
GO = (ROOT / "media-go/main.go").read_text(encoding="utf-8")
ZIPCACHE = (ROOT / "media-go/zip_cache.go").read_text(encoding="utf-8")
AUDIOGO = (ROOT / "media-go/audio_metadata.go").read_text(encoding="utf-8")

class V0913Contracts(unittest.TestCase):
    def test_music_scrape_uses_authenticated_backend_not_browser_musicbrainz(self):
        self.assertIn('/api/media/audio/metadata?', JS)
        self.assertNotIn('fetch(`https://musicbrainz.org/ws/2/recording/', JS)
        self.assertIn('/api/media/audio/metadata', GO)

    def test_detail_actions_have_watched_and_edit(self):
        self.assertIn('toggleMovieWatched', JS)
        self.assertIn('已观看', JS)
        self.assertIn('openMediaMetadataEditor', JS)
        self.assertIn('mediaMetadataEditorModal', HTML)
        self.assertIn('movie-detail-actions', JS)

    def test_all_artwork_roles_render(self):
        self.assertIn('meta.fanart', JS)
        self.assertIn('meta.backdrop', JS)
        self.assertIn('movie-detail-logo', JS)
        self.assertIn('.movie-detail-logo', CSS)

    def test_series_keeps_logo_fanart_and_uses_watched_state(self):
        self.assertIn('logo: meta.logo || ""', JS)
        self.assertIn('fanart: meta.fanart || ""', JS)
        self.assertIn('logo:show.logo', JS)
        self.assertIn('fanart:show.fanart', JS)
        self.assertNotIn('toggleMovieReadState', JS)
        movie_block = JS.split('function renderMoviePoster', 1)[1].split('function ', 1)[0]
        self.assertNotIn('✓ 已读', movie_block)
        self.assertIn('✓ 已观看', movie_block)

    def test_editor_supports_url_and_library_file(self):
        for token in ('mediaEditPosterUrl', 'mediaEditLogoUrl', 'mediaEditFanartUrl', 'mediaEditBackdropUrl', 'mediaEditArtworkChoices', 'mediaEditTags'):
            self.assertIn(token, HTML)
        self.assertIn('/api/media/metadata/artwork?', JS)
        self.assertIn('/api/media/metadata/override?', JS)

    def test_version_is_0913(self):
        self.assertIn('v0.9.56', HTML)
        self.assertNotIn('?v=0.9.13', HTML)

    # v0.9.56: ZIP/CBZ archive directory cache + iTunes-first music scraper
    def test_v0953_zip_directory_cache_exists(self):
        self.assertIn('newZipArchiveCache', ZIPCACHE)
        self.assertIn('rawIdx', ZIPCACHE)
        self.assertIn('orphans', ZIPCACHE)
        self.assertIn('a.zipCacheMu', GO)

    def test_v0953_audio_scraper_prefers_itunes(self):
        self.assertIn('itunesSearchBase', AUDIOGO)
        self.assertIn('Provider: "iTunes"', AUDIOGO)
        self.assertIn('itunesPick(title, artist, data.Results)', AUDIOGO)
        self.assertIn('scrapeAudioMusicBrainz', AUDIOGO)
        self.assertIn('audioHiResArtwork', AUDIOGO)

    def test_v0953_playlist_and_cover_contracts(self):
        self.assertIn('audioPlaylistModal', HTML)
        self.assertIn('playlist-pick-row', CSS)
        self.assertIn('graphql.anilist.co', JS)
        self.assertIn('firstCover', JS)

if __name__ == '__main__':
    unittest.main()
