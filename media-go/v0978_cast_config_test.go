package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCastAvatarRejectsBadPerson(t *testing.T) {
	allowAllReadAuth(t)
	a := &App{tmdbAPIKey: "x", tmdbImageBase: "https://image.tmdb.org/t/p"}
	for _, person := range []string{"/bad..", "//evil", "/a/../../etc/x"} {
		rec := httptest.NewRecorder()
		a.castAvatar(rec, httptest.NewRequest(http.MethodGet, "/api/media/cast/avatar?person="+person, nil))
		if rec.Code != 400 {
			t.Fatalf("person %q: want 400 got %d", person, rec.Code)
		}
	}
}
