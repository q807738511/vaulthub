package main

import (
	"testing"
	"time"
)

/* v0.9.89：子进程守护回归。
 *
 * 生产事故里 media-api 因 fatal error 退出后没人拉起，界面一直 502。
 * 这里用一个立刻退出的假进程验证：守护循环会按退避重启、计数递增，
 * 并在 stopCh 关闭后及时退出（不能在容器关闭时继续拉起新进程）。
 */

func TestV0989SuperviseRestartsChild(t *testing.T) {
	m := &manager{stopCh: make(chan struct{}), childRestarts: map[string]int{}}
	done := make(chan struct{})
	go func() {
		m.supervise("probe", "/bin/sh", "-c", "exit 7")
		close(done)
	}()

	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) && m.restartCount("probe") < 2 {
		time.Sleep(50 * time.Millisecond)
	}
	if got := m.restartCount("probe"); got < 2 {
		t.Fatalf("崩溃的子进程应被自动拉起至少 2 次，实际 %d 次", got)
	}
	if got := m.childCount(); got < 2 {
		t.Fatalf("每次拉起都应登记到子进程表，实际 %d 条", got)
	}
	snap := m.restartSnapshot()
	if snap["probe"] < 2 {
		t.Fatalf("重启计数应可被 /api/system/runtime 读到，得到 %v", snap)
	}

	m.stopChildren()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("stopCh 关闭后守护循环应退出，否则容器关闭时会不断拉起新进程")
	}
}

func TestV0989StopChildrenIsOnce(t *testing.T) {
	m := &manager{stopCh: make(chan struct{})}
	m.stopChildren()
	m.stopChildren() // 重复调用不能 panic（sync.Once）
	if !m.stoppingNow() {
		t.Fatal("stopChildren 之后 stoppingNow 应为 true")
	}
}
