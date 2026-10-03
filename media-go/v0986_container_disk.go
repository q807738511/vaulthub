package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

/* v0.9.86（客户反馈）：硬盘信息把容量展示了两遍 —— 一份挂在温度行（汇总所有映射空间
 * 的剩余/总量），一份是 VHDATA 卷列表本身。并且要求：
 *   「如果不映射空间，则展示容器所在硬盘位置的温度」。
 *
 * 因此服务端补一个 container_disk 字段：容器数据目录落在哪块盘、这块盘的
 * 容量与（能对上传感器时）温度。前端据此决定：
 *   · 有映射空间（filesystems 非空）→ 容量只在卷列表展示一次；温度取硬盘传感器；
 *   · 没有映射空间 → 温度与容量都取容器所在硬盘（本结构）。
 *
 * 设备名匹配不追求完美：认不出就 matched=false，前端回落到「最热传感器」，
 * 绝不因此让监控卡变空。
 */

type containerDiskInfo struct {
	Path    string  `json:"path"`
	Device  string  `json:"device"`
	Temp    float64 `json:"temp"`
	Total   uint64  `json:"total"`
	Used    uint64  `json:"used"`
	Free    uint64  `json:"free"`
	Percent int     `json:"percent"`
	Matched bool    `json:"matched"`
}

// containerDisk 计算容器数据目录的落盘信息；任何一步失败都返回零值结构（不报错）。
func containerDisk(dataPath string, diskTemps []map[string]any) containerDiskInfo {
	out := containerDiskInfo{Path: dataPath}
	if dataPath == "" {
		return out
	}
	if dev := deviceForPath(mountsSource(), dataPath); dev != "" {
		out.Device = filepath.Base(dev)
	}
	var st syscall.Statfs_t
	if syscall.Statfs(dataPath, &st) == nil {
		bsize := uint64(st.Bsize)
		out.Total = st.Blocks * bsize
		out.Free = st.Bavail * bsize
		out.Used = out.Total - st.Bfree*bsize
		if out.Total > 0 {
			out.Percent = int(float64(out.Used) / float64(out.Total) * 100.0)
		}
	}
	if temp, ok := tempForDevice(out.Device, diskTemps); ok {
		out.Temp, out.Matched = temp, true
	}
	return out
}

func mountsSource() string {
	if v := env("SYSTEM_MONITOR_MOUNTS", ""); v != "" {
		return v
	}
	return "/proc/mounts"
}

// deviceForPath 在 mounts 里找「挂载点最长且是 path 前缀」的那条的设备名。
func deviceForPath(mountsFile, path string) string {
	b, err := os.ReadFile(mountsFile)
	if err != nil {
		return ""
	}
	clean := filepath.Clean(path)
	best, bestLen := "", -1
	for _, line := range strings.Split(string(b), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		dev, mount := fields[0], unescapeMount(fields[1])
		if dev == "" || !strings.HasPrefix(dev, "/dev/") {
			continue
		}
		m := filepath.Clean(mount)
		if clean != m && !strings.HasPrefix(clean, strings.TrimSuffix(m, "/")+"/") {
			continue
		}
		if len(m) > bestLen {
			best, bestLen = dev, len(m)
		}
	}
	return best
}

// unescapeMount 还原 /proc/mounts 里 \040 这类八进制转义（空格路径很常见）。
func unescapeMount(s string) string {
	if !strings.Contains(s, "\\") {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if n, err := strconv.ParseUint(s[i+1:i+4], 8, 16); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// blockDeviceBase 把 /dev/sda1 → sda，/dev/nvme0n1p2 → nvme0n1，/dev/mmcblk0p1 → mmcblk0。
func blockDeviceBase(dev string) string {
	d := strings.ToLower(strings.TrimPrefix(dev, "/dev/"))
	if i := strings.LastIndex(d, "p"); i > 0 && i+1 < len(d) && allDigits(d[i+1:]) && !allDigits(d) {
		if strings.HasPrefix(d, "nvme") || strings.HasPrefix(d, "mmcblk") {
			return d[:i]
		}
	}
	for len(d) > 0 && d[len(d)-1] >= '0' && d[len(d)-1] <= '9' {
		d = d[:len(d)-1]
	}
	return d
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// tempForDevice 用设备基名去匹配 hwmon 报出来的硬盘温度（drivetemp / nvme）。
func tempForDevice(device string, diskTemps []map[string]any) (float64, bool) {
	base := blockDeviceBase(device)
	if base == "" {
		return 0, false
	}
	for _, e := range diskTemps {
		name := strings.ToLower(strings.TrimSpace(strAny(e["name"])))
		if name == "" {
			continue
		}
		nbase := blockDeviceBase(name)
		if name == base || nbase == base || strings.Contains(name, base) || strings.Contains(base, nbase) {
			t := numAny(e["temp"])
			if t > 0 {
				return t, true
			}
		}
	}
	return 0, false
}

func strAny(v any) string {
	s, _ := v.(string)
	return s
}

func numAny(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case string:
		f, _ := strconv.ParseFloat(x, 64)
		return f
	}
	return 0
}
