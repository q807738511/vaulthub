#!/usr/bin/env python3
"""scripts/merge-env.sh contract: key-level merge of vaulthub.env.

Guarantees exercised against the real shell script:
  * appends ONLY keys missing locally (template order, leading comments kept),
    never touches keys the user already has (custom values preserved);
  * values containing '=' (URLs) are appended verbatim;
  * backs up the local file before writing (vaulthub.env.bak-<ts>);
  * idempotent: a second run adds nothing and creates no extra backup;
  * no new keys -> no modification, exit 0;
  * dry-run (-n) prints the would-be block without writing;
  * missing local file -> whole template copied.
"""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "merge-env.sh"

TEMPLATE = """\
# 基础时区
TZ=${TZ:-Asia/Shanghai}

# ---------- 缓存清理 ----------
MEDIA_CACHE_MAX_BYTES=${MEDIA_CACHE_MAX_BYTES:-30737418240}
# 例：http://192.168.112.3:7890；留空表示直连
SCRAPER_PROXY=${SCRAPER_PROXY:-}

# 字幕端点（URL 内含 = 号，必须原样保留）
SUBTITLE_ENDPOINT=${SUBTITLE_ENDPOINT:-https://api.example.com/sub?site=a&=1}
"""


def run_merge(args, cwd):
    return subprocess.run(
        ["sh", str(SCRIPT), *args], cwd=cwd, capture_output=True, text=True
    )


class MergeEnvTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="vh-merge-"))

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, name, content):
        (self.dir / name).write_text(content, encoding="utf-8")

    def read(self, name):
        return (self.dir / name).read_text(encoding="utf-8")

    def backups(self):
        return sorted((self.dir).glob("vaulthub.env.bak-*"))

    # ---- 核心：只补缺失键，保留本地值 ----
    def test_appends_missing_keys_preserving_local_values(self):
        self.write("vaulthub.env", "TZ=Asia/Tokyo\nMEDIA_CACHE_MAX_BYTES=1\nOLD_X=${OLD_X:-x}\n")
        self.write("new.env", TEMPLATE)
        r = run_merge(["new.env"], self.dir)
        self.assertEqual(r.returncode, 0, r.stderr)
        merged = self.read("vaulthub.env")
        # 本地已有的键原样保留（含自定义值）
        self.assertIn("TZ=Asia/Tokyo", merged)
        self.assertIn("MEDIA_CACHE_MAX_BYTES=1", merged)
        self.assertIn("OLD_X=${OLD_X:-x}", merged)
        self.assertEqual(merged.count("TZ="), 1, "must not duplicate existing keys")
        # 缺失键被补入：默认值 + 紧邻注释
        self.assertIn("SCRAPER_PROXY=${SCRAPER_PROXY:-}", merged)
        self.assertIn("# 例：http://192.168.112.3:7890；留空表示直连", merged)
        self.assertIn("SUBTITLE_ENDPOINT=${SUBTITLE_ENDPOINT:-https://api.example.com/sub?site=a&=1}", merged)
        self.assertIn("# 字幕端点（URL 内含 = 号，必须原样保留）", merged)
        # 备份已生成且内容等于原文件
        self.assertEqual(len(self.backups()), 1)
        self.assertEqual(self.read(self.backups()[0].name), "TZ=Asia/Tokyo\nMEDIA_CACHE_MAX_BYTES=1\nOLD_X=${OLD_X:-x}\n")
        self.assertIn("2 个新键", r.stdout)

    # ---- 幂等 ----
    def test_second_run_is_noop(self):
        self.write("vaulthub.env", "TZ=Asia/Tokyo\n")
        self.write("new.env", TEMPLATE)
        r1 = run_merge(["new.env"], self.dir)
        self.assertEqual(r1.returncode, 0)
        r2 = run_merge(["new.env"], self.dir)
        self.assertEqual(r2.returncode, 0)
        self.assertIn("无新增键", r2.stdout)
        self.assertEqual(len(self.backups()), 1, "no-op run must not create a backup")
        self.assertEqual(self.read("vaulthub.env").count("SCRAPER_PROXY="), 1)

    # ---- 无新键 -> 零修改 ----
    def test_no_new_keys_leaves_file_untouched(self):
        self.write("vaulthub.env", "TZ=Asia/Shanghai\nMEDIA_CACHE_MAX_BYTES=5\nSCRAPER_PROXY=\nSUBTITLE_ENDPOINT=x\n")
        self.write("new.env", TEMPLATE)
        before = self.read("vaulthub.env")
        r = run_merge(["new.env"], self.dir)
        self.assertEqual(r.returncode, 0)
        self.assertIn("无新增键", r.stdout)
        self.assertEqual(self.read("vaulthub.env"), before)
        self.assertEqual(len(self.backups()), 0)

    # ---- dry-run 不落盘 ----
    def test_dry_run_does_not_modify(self):
        self.write("vaulthub.env", "TZ=Asia/Shanghai\n")
        self.write("new.env", TEMPLATE)
        before = self.read("vaulthub.env")
        r = run_merge(["-n", "new.env"], self.dir)
        self.assertEqual(r.returncode, 0)
        self.assertIn("[dry-run]", r.stdout)
        self.assertIn("SCRAPER_PROXY=${SCRAPER_PROXY:-}", r.stdout)
        self.assertEqual(self.read("vaulthub.env"), before)
        self.assertEqual(len(self.backups()), 0)

    # ---- 本地文件缺失 -> 整体复制模板 ----
    def test_creates_file_from_scratch(self):
        self.write("new.env", TEMPLATE)
        r = run_merge(["new.env"], self.dir)
        self.assertEqual(r.returncode, 0)
        self.assertIn("整体创建", r.stdout)
        self.assertEqual(self.read("vaulthub.env"), TEMPLATE)

    # ---- -l 指定本地文件 ----
    def test_custom_local_path(self):
        self.write("custom.env", "TZ=Asia/Tokyo\n")
        self.write("new.env", TEMPLATE)
        r = run_merge(["-l", "custom.env", "new.env"], self.dir)
        self.assertEqual(r.returncode, 0)
        self.assertIn("SUBTITLE_ENDPOINT=", self.read("custom.env"))
        self.assertIn("TZ=Asia/Tokyo", self.read("custom.env"))

    # ---- 缺少模板参数 -> 用法错误 ----
    def test_missing_template_argument_fails(self):
        r = run_merge([], self.dir)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("用法", r.stdout + r.stderr)

    # ---- 模板文件不存在 -> 报错退出 ----
    def test_missing_template_file_fails(self):
        self.write("vaulthub.env", "TZ=Asia/Shanghai\n")
        r = run_merge(["no-such.env"], self.dir)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("模板文件不存在", r.stderr)
        self.assertEqual(self.read("vaulthub.env"), "TZ=Asia/Shanghai\n")


if __name__ == "__main__":
    unittest.main(verbosity=2)
