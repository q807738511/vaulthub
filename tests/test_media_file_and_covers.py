#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = (root / "media-api.c").read_text()
html = (root / "index.html").read_text()

assert 'query_value(query,"path")' in source, "media API lacks query-parameter file path support"
assert 'query_value(query,"id")' in source, "media API lacks query-parameter library id support"
assert 'url_decode_component' in source, "media API lacks bounded query component decoding"
assert 'encodeURIComponent(String(path))' in html, "frontend does not percent-encode book path for query transmission"
assert 'url.searchParams.set("path", String(path))' not in html, "frontend still uses form-style query encoding that mangles + in paths"
assert 'scrapeBookCover' in html, "cover scraper is missing"
assert 'openlibrary.org/search.json' in html, "fallback book metadata source is missing"
assert 'www.googleapis.com/books/v1/volumes' in html, "primary book metadata source is missing"
assert 'covers.openlibrary.org' in html, "scraped cover image source is missing"
assert 'refreshBookCovers' in html, "manual cover re-scrape action is missing"
assert 'coverScrapeCache' in html, "cover scraping results are not cached"
assert 'onerror="bookCoverFallback(this)"' in html, "failed cover image does not fall back to title cover"

print("PASS: stable file URL and cached cover scraping are present")
