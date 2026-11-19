#!/usr/bin/env python3
"""Tests for the PreToolUse hook that runs the comment / Markdown policy before git commit."""

import importlib.util
import io
import json
import subprocess
import unittest
from pathlib import Path
from unittest import mock


def _load_module():
    path = Path(__file__).with_name("repo_policy.py")
    spec = importlib.util.spec_from_file_location("repo_policy", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


hook = _load_module()


class IsGitCommitTest(unittest.TestCase):
    def test_detects_plain_and_chained_commits(self):
        for command in [
            "git commit -m x",
            "git add -A && git commit -q -F - <<'EOF'\nmsg\nEOF",
            "cd /repo; git commit --amend",
            "git -C /repo commit -m x",
            "git -c user.name=a commit -m x",
            "git --no-pager commit -m x",
        ]:
            with self.subTest(command=command):
                self.assertTrue(hook.is_git_commit(command))

    def test_ignores_other_commands(self):
        for command in [
            "git status",
            "git log --grep commit",
            "echo git commit",
            "git -C commit status",
            "npm run commit",
            "",
        ]:
            with self.subTest(command=command):
                self.assertFalse(hook.is_git_commit(command))


def _run_main(command, returncode=0, output=""):
    payload = json.dumps({"tool_input": {"command": command}, "cwd": "/repo"})
    completed = subprocess.CompletedProcess([], returncode, stdout="", stderr=output)
    stderr = io.StringIO()
    with mock.patch("sys.stdin", io.StringIO(payload)), mock.patch(
        "sys.stderr", stderr
    ), mock.patch.object(hook.subprocess, "run", return_value=completed) as run:
        with _Exit() as exited:
            hook.main()
    return exited.code, stderr.getvalue(), run


class _Exit:
    code = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is SystemExit:
            self.code = exc.code
            return True
        return False


class HookProtocolTest(unittest.TestCase):
    def test_does_nothing_for_non_commit_commands(self):
        code, _, run = _run_main("git status")
        self.assertEqual(code, 0)
        run.assert_not_called()

    def test_passes_a_clean_commit(self):
        code, _, run = _run_main("git commit -m x", returncode=0)
        self.assertEqual(code, 0)
        run.assert_called_once()

    def test_blocks_a_commit_with_violations_and_shows_them(self):
        code, stderr, _ = _run_main(
            "git commit -m x", returncode=1, output="apps/web/src/a.ts:1: コメント // x\n"
        )
        self.assertEqual(code, 2)
        self.assertIn("apps/web/src/a.ts:1", stderr)


if __name__ == "__main__":
    unittest.main()
