package main

import "testing"

/* v0.9.84：蓝光原盘结构文件不再进索引 —— 客户反馈「新增了部分不带元数据的视频文件，
   无法进行刮削」：一部原盘 600+ 个 .mpls/.clpi/.bdmv 结构文件被当成 600+ 条「影片」，
   片段文件名（00011.m2ts）也永远刮不到。这里锁定「跳过什么、保留什么」的边界。 */

func TestV0984BluRayStructureFilesAreSkipped(t *testing.T) {
	disc := "[黑鹰坠落]Black.Hawk.Down.2001.Blu-ray.1080p.AVC.LPCM5.1.DTS-HD.MA7.1-HDbits@CHDBits/[黑鹰坠落]Black.Hawk.Down.2001.Blu-ray.1080p.AVC.LPCM5.1.DTS-HD.MA7.1/BDMV/"
	skipped := []string{
		disc + "PLAYLIST/00222.mpls",
		disc + "CLIPINF/00081.clpi",
		disc + "MovieObject.bdmv",
		disc + "index.bdmv",
		disc + "BACKUP/PLAYLIST/00011.mpls",
		disc + "AUXDATA/sound.bdmv",
		disc + "META/DL/bdmt_eng.xml",
		disc + "JAR/88888.jar",
		"CERTIFICATE/BACKUP/00001.otf",
		"CERTIFICATE/id.bdmv",
	}
	for _, rel := range skipped {
		if !skipIndexFile(rel) {
			t.Errorf("原盘结构文件应跳过索引：%s", rel)
		}
	}
	kept := []string{
		disc + "STREAM/00011.m2ts",
		disc + "STREAM/00106.mts",
		"[五个扑水的少年].Water.Boys.2021.2160p.WEB-DL.H.265.AAC-AilMWeb/[五个扑水的少年].Water.Boys.2021.2160p.WEB-DL.H.265.AAC-AilMWeb.mp4",
		"剧集/强风吹拂/Season 01/S01E01.mkv",
		"剧集/强风吹拂/Season 01/S01E01.zh.srt",
		"剧集/强风吹拂/tvshow.nfo",
		"音乐/专辑/01 测试音轨.mp3",
		"漫画/真实样例.cbz",
	}
	for _, rel := range kept {
		if skipIndexFile(rel) {
			t.Errorf("真实媒体/边车文件不应被跳过：%s", rel)
		}
	}
}

func TestV0984BluRayDetectionIsCaseAndShapeTolerant(t *testing.T) {
	cases := map[string]bool{
		"movie/Bdmv/Stream/00001.m2ts":     false, // 大小写混合：仍识别为原盘，但 .m2ts 保留
		"movie/bdmv/playlist/00001.mpls":   true,
		"movie/Certificate/app.desc":       true,
		"普通电影/电影名 (2020)/电影名.mp4":         false,
		"music/BDMV-soundtrack/01 song.mp3": false, // 只是名字里带 BDMV，不是原盘结构
	}
	for rel, want := range cases {
		if got := skipIndexFile(rel); got != want {
			t.Errorf("skipIndexFile(%q) = %v，期望 %v", rel, got, want)
		}
	}
}
