#!/usr/bin/env python3
"""Tests for the PostToolUse hook that formats an edited file with Prettier."""

import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path("/repo")
HOOK = Path(__file__).with_name("format_on_edit.py")


def _load_module():
    spec = importlib.util.spec_from_file_location("format_on_edit", HOOK)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


hook = _load_module()


def run_hook(payload, project_dir):
    return subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env={**os.environ, "CLAUDE_PROJECT_DIR": str(project_dir)},
    )


class RelativeTargetTest(unittest.TestCase):
    def test_returns_the_path_inside_the_project(self):
        self.assertEqual(hook.relative_target(ROOT / "apps/web/src/a.tsx", ROOT), "apps/web/src/a.tsx")
        self.assertEqual(hook.relative_target(ROOT / "docs/spec/x.md", ROOT), "docs/spec/x.md")

    def test_ignores_files_outside_the_project(self):
        self.assertIsNone(hook.relative_target(Path("/elsewhere/a.ts"), ROOT))

    def test_ignores_files_inside_git_metadata(self):
        self.assertIsNone(hook.relative_target(ROOT / ".git/COMMIT_EDITMSG", ROOT))


class FormatCommandTest(unittest.TestCase):
    def test_uses_the_root_prettier_and_leaves_exclusions_to_its_ignore_files(self):
        command = hook.format_command(ROOT, "apps/web/src/a.tsx")
        self.assertEqual(command[0], "/repo/node_modules/.bin/prettier")
        self.assertIn("--write", command)
        # 拡張子の判定を写さず Prettier に任せる。対象外（.py や .prettierignore の中）は黙って飛ばす。
        self.assertIn("--ignore-unknown", command)
        self.assertEqual(command[-1], "apps/web/src/a.tsx")


class HookProtocolTest(unittest.TestCase):
    def test_does_nothing_when_prettier_is_not_installed(self):
        with tempfile.TemporaryDirectory() as project:
            target = Path(project) / "a.ts"
            target.write_text("const a = \"x\"\n")
            result = run_hook({"tool_input": {"file_path": str(target)}}, project)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stderr, "")
            self.assertEqual(target.read_text(), "const a = \"x\"\n")

    def test_runs_prettier_from_the_project_root_on_the_edited_file(self):
        with tempfile.TemporaryDirectory() as project:
            bin_dir = Path(project) / "node_modules" / ".bin"
            bin_dir.mkdir(parents=True)
            fake = bin_dir / "prettier"
            # 受け取った引数と作業ディレクトリを書き残すだけの偽物。
            fake.write_text('#!/bin/sh\necho "$PWD $*" > "$PWD/called"\n')
            fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
            target = Path(project) / "src" / "a.ts"
            target.parent.mkdir()
            target.write_text("")
            result = run_hook({"tool_input": {"file_path": str(target)}}, project)
            self.assertEqual(result.returncode, 0)
            cwd, *args = (Path(project) / "called").read_text().split()
            self.assertEqual(Path(cwd).resolve(), Path(project).resolve())
            self.assertEqual(args[-2:], ["--write", "src/a.ts"])

    def test_stays_silent_when_prettier_fails(self):
        # 構文の壊れたファイルは Prettier が整形できない。その指摘は型検査のフックが出す。
        with tempfile.TemporaryDirectory() as project:
            bin_dir = Path(project) / "node_modules" / ".bin"
            bin_dir.mkdir(parents=True)
            fake = bin_dir / "prettier"
            fake.write_text("#!/bin/sh\necho 'SyntaxError' >&2\nexit 2\n")
            fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
            target = Path(project) / "a.ts"
            target.write_text("const = ;\n")
            result = run_hook({"tool_input": {"file_path": str(target)}}, project)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stderr, "")

    def test_skips_payloads_without_a_file_path(self):
        result = run_hook({"tool_input": {}}, ROOT)
        self.assertEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
