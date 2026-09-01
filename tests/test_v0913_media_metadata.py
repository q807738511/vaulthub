#!/usr/bin/env python3
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
GO = (ROOT / "media-go/main.go").read_text(encoding="utf-8")

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

    def test_editor_supports_url_and_library_file(self):
        for token in ('mediaEditPosterUrl', 'mediaEditLogoUrl', 'mediaEditFanartUrl', 'mediaEditBackdropUrl', 'mediaEditArtworkChoices', 'mediaEditTags'):
            self.assertIn(token, HTML)
        self.assertIn('/api/media/metadata/artwork?', JS)
        self.assertIn('/api/media/metadata/override?', JS)

    def test_version_is_0913(self):
        self.assertIn('v0.9.13', HTML)
        self.assertNotIn('?v=0.9.12', HTML)

if __name__ == '__main__':
    unittest.main()
