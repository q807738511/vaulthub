package main

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

const ffmpegErrorLimit = 64 << 10

type boundedErrorBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (w *boundedErrorBuffer) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	remaining := ffmpegErrorLimit - w.b.Len()
	if remaining > 0 {
		if len(p) > remaining {
			_, _ = w.b.Write(p[:remaining])
		} else {
			_, _ = w.b.Write(p)
		}
	}
	return len(p), nil
}
func (w *boundedErrorBuffer) String() string { w.mu.Lock(); defer w.mu.Unlock(); return w.b.String() }

var ffmpegPathMu sync.Mutex
var ffmpegPathByEnv = map[string]string{}

// trustedFFmpegPath 把 PATH 查找结果固定为绝对路径，并拒绝可被任意用户写入的目录。
// 按 PATH 值缓存是为了让隔离测试可注入假 ffmpeg；生产容器 PATH 不变，因此只解析一次。
func trustedFFmpegPath() (string, error) {
	envPath := os.Getenv("PATH")
	ffmpegPathMu.Lock()
	defer ffmpegPathMu.Unlock()
	if p := ffmpegPathByEnv[envPath]; p != "" {
		return p, nil
	}
	p, err := exec.LookPath("ffmpeg")
	if err != nil {
		return "", err
	}
	p, err = filepath.Abs(p)
	if err != nil {
		return "", err
	}
	fi, err := os.Stat(p)
	if err != nil || !fi.Mode().IsRegular() || fi.Mode()&0o111 == 0 {
		return "", errors.New("ffmpeg is not a regular executable")
	}
	dir, err := os.Stat(filepath.Dir(p))
	if err != nil || dir.Mode().Perm()&0o002 != 0 {
		return "", errors.New("ffmpeg directory is world-writable")
	}
	ffmpegPathByEnv[envPath] = p
	return p, nil
}

var _ io.Writer = (*boundedErrorBuffer)(nil)
