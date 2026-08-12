#!/usr/bin/env python3
"""Tests for the doc/comment staleness checks (#357)."""

import importlib.util
import json
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


def _load():
    path = Path(__file__).with_name("doc_consistency.py")
    spec = importlib.util.spec_from_file_location("doc_consistency", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


dc = _load()
SCRIPT = str(Path(dc.__file__))
COMMIT_PAYLOAD = {"tool_name": "Bash", "tool_input": {"command": "git commit -m x"}}


def git(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def write(repo, rel, text):
    p = repo / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(textwrap.dedent(text), encoding="utf-8")


def run_hook(repo, payload=None):
    return subprocess.run(
        [sys.executable, SCRIPT],
        input=json.dumps(payload or COMMIT_PAYLOAD),
        text=True,
        capture_output=True,
        cwd=str(repo),
        check=False,
    )


class Repo:
    """A throwaway git repo shaped like this project (lib/ + docs/spec/)."""

    def __enter__(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name)
        git(self.path, "init", "-q")
        git(self.path, "config", "user.email", "t@t")
        git(self.path, "config", "user.name", "t")
        write(self.path, "docs/spec/route-optimization.md", "## 1. 目的\n\n## 2. データ源\n\n### 2.3 コリドー\n")
        write(self.path, "lib/probe.dart", "const int probeThresholdValue = 3;\n")
        write(self.path, "lib/user.dart", "/// 判定は [probeThresholdValue] を境目にする。\nclass User {}\n")
        self.commit("setup")
        return self

    def __exit__(self, *exc):
        self._tmp.cleanup()

    def commit(self, msg):
        git(self.path, "add", "-A")
        git(self.path, "commit", "-q", "-m", msg)

    def stage_all(self):
        git(self.path, "add", "-A")


class WordBoundaryTest(unittest.TestCase):
    """`git grep -E` は `\\b` / `\\s` を解釈せず、エラーにせず 0 件を返す。
    検査が黙って何も見つけない状態になるため、パターンに混入させない。"""

    def test_word_boundary_pattern_avoids_backslash_b_and_s(self):
        pattern = dc.word_re("foo")

        self.assertNotIn(r"\b", pattern)
        self.assertNotIn(r"\s", pattern)

    def test_git_grep_actually_matches_the_word_boundary_pattern(self):
        with Repo() as repo:
            out = subprocess.run(
                ["git", "grep", "-n", "-E", dc.word_re("probeThresholdValue"), "--", *dc.CODE_GLOBS],
                cwd=str(repo.path), capture_output=True, text=True, check=False,
            )

            self.assertIn("lib/user.dart", out.stdout)


class RemovedDeclarationsTest(unittest.TestCase):
    def test_picks_up_a_deleted_top_level_const(self):
        diff = "--- a/lib/probe.dart\n-const int probeThresholdValue = 3;\n"

        self.assertIn("probeThresholdValue", dc.removed_declarations(diff))

    def test_picks_up_a_deleted_private_member(self):
        diff = "-  static const int _boardSearchFanout = 5;\n"

        self.assertIn("_boardSearchFanout", dc.removed_declarations(diff))

    def test_ignores_deleted_comment_lines(self):
        diff = "-  /// class SomethingDescribed が消えたわけではない\n"

        self.assertEqual(dc.removed_declarations(diff), set())


class CommentExtractionTest(unittest.TestCase):
    def test_reads_only_comment_lines_from_source(self):
        text = "// 先頭コメント\nfinal x = 1; // 行末は対象外\n/// doc\n"

        self.assertEqual(dc.comment_lines(text, "lib/a.dart"), [(1, "// 先頭コメント"), (3, "/// doc")])

    def test_treats_every_line_of_markdown_as_prose(self):
        self.assertEqual(dc.comment_lines("a\nb\n", "docs/x.md"), [(1, "a"), (2, "b")])


class HookTest(unittest.TestCase):
    def test_blocks_a_commit_that_removes_a_symbol_still_named_in_a_comment(self):
        with Repo() as repo:
            (repo.path / "lib/probe.dart").unlink()
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("probeThresholdValue", result.stderr)

    def test_allows_a_commit_that_moves_the_declaration_elsewhere(self):
        with Repo() as repo:
            (repo.path / "lib/probe.dart").unlink()
            write(repo.path, "lib/moved.dart", "const int probeThresholdValue = 3;\n")
            repo.stage_all()

            self.assertEqual(run_hook(repo.path).returncode, 0)

    def test_allows_a_commit_that_removes_the_comment_along_with_the_symbol(self):
        with Repo() as repo:
            (repo.path / "lib/probe.dart").unlink()
            write(repo.path, "lib/user.dart", "class User {}\n")
            repo.stage_all()

            self.assertEqual(run_hook(repo.path).returncode, 0)

    def test_blocks_a_comment_pointing_at_a_path_that_does_not_exist(self):
        with Repo() as repo:
            write(repo.path, "lib/user.dart", "/// 詳細は lib/core/gone.dart を見る。\nclass User {}\n")
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("lib/core/gone.dart", result.stderr)

    def test_blocks_a_comment_citing_a_spec_section_that_does_not_exist(self):
        with Repo() as repo:
            write(repo.path, "lib/user.dart", "/// 詳細は §9.9 を見る。\nclass User {}\n")
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("§9.9", result.stderr)

    def test_allows_a_comment_citing_a_spec_section_that_exists(self):
        with Repo() as repo:
            write(repo.path, "lib/user.dart", "/// 詳細は §2.3 を見る。\nclass User {}\n")
            repo.stage_all()

            self.assertEqual(run_hook(repo.path).returncode, 0)

    def test_stays_out_of_the_way_of_bash_commands_that_are_not_commits(self):
        with Repo() as repo:
            (repo.path / "lib/probe.dart").unlink()
            repo.stage_all()

            payload = {"tool_name": "Bash", "tool_input": {"command": "git status --short"}}

            self.assertEqual(run_hook(repo.path, payload).returncode, 0)


if __name__ == "__main__":
    unittest.main()
