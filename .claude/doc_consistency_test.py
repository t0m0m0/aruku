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


class WordMatchTest(unittest.TestCase):
    def test_matches_the_symbol_as_a_whole_word(self):
        pattern = dc.word_re("planRoute")

        self.assertTrue(pattern.search("[planRoute] を呼ぶ"))
        self.assertTrue(pattern.search("planRoute()"))

    def test_does_not_match_a_longer_identifier_that_contains_it(self):
        pattern = dc.word_re("planRoute")

        self.assertIsNone(pattern.search("planRouteFast()"))
        self.assertIsNone(pattern.search("_planRoute"))


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

    def test_picks_up_dart_modifier_based_class_declarations(self):
        for line, expected in [
            ("-sealed class LocationState {", "LocationState"),
            ("-abstract interface class RouteService {", "RouteService"),
            ("-abstract class AppLocalizations {", "AppLocalizations"),
        ]:
            with self.subTest(line=line):
                self.assertIn(expected, dc.removed_declarations(line))

    def test_picks_up_a_const_whose_type_is_inferred(self):
        self.assertIn("_pageCount", dc.removed_declarations("-  static const _pageCount = 3;"))

    def test_picks_up_a_method_and_a_getter(self):
        self.assertIn("planRoute", dc.removed_declarations("-  Future<void> planRoute(int x) {"))
        self.assertIn("matrixCalls", dc.removed_declarations("-  int get matrixCalls => _matrixCalls;"))

    def test_ignores_local_variables_inside_a_method_body(self):
        """局所名は散文の普通の英単語に当たる。コメントが指すのは API シンボル。"""
        diff = "-    final files = captured?.files ?? const [];\n-      final bestIndex = 0;\n"

        self.assertEqual(dc.removed_declarations(diff), set())

    def test_ignores_generic_lowercase_names(self):
        self.assertEqual(dc.removed_declarations("-const files = 1;"), set())
        self.assertIn("roundTrips", dc.removed_declarations("-  int get roundTrips => 1;"))

    def test_picks_up_a_record_returning_declaration(self):
        """`({int cum, int wait}) _advance(...)` はこのリポジトリで実際に使う形。"""
        self.assertIn("_advance", dc.removed_declarations("-({int cum, int wait}) _advance(int x) {"))
        self.assertIn(
            "prewarmFront",
            dc.removed_declarations("-({List<int> prewarm, bool singlePass}) prewarmFront({"),
        )

    def test_does_not_mistake_statements_for_declarations(self):
        for line in [
            "-    return calculateRoute(input);",
            "-  runApp(const App());",
            "-  while (isReadyForDeparture()) {",
            "-    throw RouteExceptionThing('x');",
        ]:
            with self.subTest(line=line):
                self.assertEqual(dc.removed_declarations(line), set())


class LineSplitTest(unittest.TestCase):
    def test_separates_comment_lines_from_code_lines(self):
        prose, code = dc.split_lines("// 先頭\nfinal x = 1;\n/// doc\n", "lib/a.dart")

        self.assertEqual([t for _, t in prose], ["// 先頭", "/// doc"])
        self.assertEqual([t.strip() for _, t in code], ["final x = 1;"])

    def test_treats_every_line_of_markdown_as_prose(self):
        prose, code = dc.split_lines("a\nb\n", "docs/x.md")

        self.assertEqual(prose, [(1, "a"), (2, "b")])
        self.assertEqual(code, [])


class InlineCommentTest(unittest.TestCase):
    def test_keeps_a_trailing_comment_out_of_the_code_line(self):
        """コード行にコメントが残ると、そのコメントが自分の検出を握り潰す。"""
        prose, code = dc.split_lines("final x = 1; // OldService handled this\n", "lib/a.dart")

        self.assertEqual([t.strip() for _, t in code], ["final x = 1;"])
        self.assertEqual([t for _, t in prose], ["// OldService handled this"])

    def test_does_not_treat_a_url_inside_a_string_as_a_comment(self):
        _, code = dc.split_lines("const u = 'https://example.com/x';\n", "lib/a.dart")

        self.assertEqual([t.strip() for _, t in code], ["const u = 'https://example.com/x';"])


class GitCommandTest(unittest.TestCase):
    def test_recognizes_commit_after_global_options(self):
        for cmd in [
            "git commit -m x",
            "git --no-pager commit -m x",
            "git -C /repo commit -m x",
            "git -c user.email=t@t commit -m x",
            "cd /repo && git commit -m x",
        ]:
            with self.subTest(cmd=cmd):
                self.assertTrue(dc.parse_git_commit(cmd)[0])

    def test_ignores_git_commands_that_are_not_commits(self):
        for cmd in ["git status --short", "git log --oneline", "git commitizen"]:
            with self.subTest(cmd=cmd):
                self.assertFalse(dc.parse_git_commit(cmd)[0])

    def test_flags_commits_that_pull_in_unstaged_content(self):
        for cmd in [
            "git commit -a -m x", "git commit -am x", "git commit --all",
            "git commit lib/a.dart", "git commit -p", "git commit --interactive",
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(dc.parse_git_commit(cmd), (True, True))

    def test_does_not_flag_a_plain_staged_commit(self):
        self.assertEqual(dc.parse_git_commit("git commit -m 'lib/a.dart を直す'"), (True, False))


class PathPatternTest(unittest.TestCase):
    def test_matches_a_path_that_ends_a_sentence(self):
        self.assertEqual(dc.PATH_RE.findall("See lib/core/gone.dart."), ["lib/core/gone.dart"])

    def test_keeps_a_multi_part_extension_whole(self):
        self.assertEqual(
            dc.PATH_RE.findall("see android/app/build.gradle.kts"), ["android/app/build.gradle.kts"]
        )

    def test_ignores_a_package_uri(self):
        self.assertEqual(dc.PATH_RE.findall("import 'package:x/lib/foo.dart';"), [])


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

    def test_does_not_let_a_stale_comment_vouch_for_its_own_symbol(self):
        """コメント自身が「まだ宣言が在る」判定に当たると、自分の検出を握り潰す。"""
        with Repo() as repo:
            write(repo.path, "lib/user.dart", "/// class probeThresholdValue が持っていた責務。\nclass User {}\n")
            (repo.path / "lib/probe.dart").unlink()
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("probeThresholdValue", result.stderr)

    def test_does_not_let_a_call_shaped_comment_vouch_for_its_own_symbol(self):
        with Repo() as repo:
            write(repo.path, "lib/user.dart", "/// 呼ぶときは probeThresholdValue() だった。\nclass User {}\n")
            (repo.path / "lib/probe.dart").unlink()
            repo.stage_all()

            self.assertEqual(run_hook(repo.path).returncode, 2)

    def test_honours_the_keep_marker_for_an_intentional_historical_reference(self):
        with Repo() as repo:
            write(
                repo.path,
                "lib/user.dart",
                "/// probeThresholdValue は #330 で撤去した。 doc-consistency:keep\nclass User {}\n",
            )
            (repo.path / "lib/probe.dart").unlink()
            repo.stage_all()

            self.assertEqual(run_hook(repo.path).returncode, 0)

    def test_rejects_a_reference_to_a_file_that_is_only_untracked(self):
        """作業ツリーに在るだけの未追跡ファイルは、クリーンな CI では存在しない。"""
        with Repo() as repo:
            write(repo.path, "lib/new_service.dart", "class NewService {}\n")
            write(repo.path, "lib/user.dart", "/// 詳細は lib/new_service.dart を見る。\nclass User {}\n")
            git(repo.path, "add", "lib/user.dart")

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("lib/new_service.dart", result.stderr)

    def test_rescans_every_code_reference_when_the_spec_is_renumbered(self):
        """節の付け替えは、変えたのが仕様書だけでも他ファイルの §N を腐らせる。"""
        with Repo() as repo:
            write(repo.path, "lib/user.dart", "/// 詳細は §2.3 を見る。\nclass User {}\n")
            repo.commit("cite 2.3")
            write(repo.path, "docs/spec/route-optimization.md", "## 1. 目的\n\n## 2. データ源\n\n### 2.4 コリドー\n")
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("§2.3", result.stderr)

    def test_does_not_let_a_trailing_comment_vouch_for_its_own_symbol(self):
        with Repo() as repo:
            write(repo.path, "lib/user.dart", "class User {} // probeThresholdValue が持っていた責務\n")
            (repo.path / "lib/probe.dart").unlink()
            repo.stage_all()

            self.assertEqual(run_hook(repo.path).returncode, 2)

    def test_inspects_unstaged_content_when_the_commit_would_include_it(self):
        """`git commit -a` はフック実行後に自動 stage する。index だけ見ると素通りする。"""
        with Repo() as repo:
            (repo.path / "lib/probe.dart").unlink()  # stage しない

            payload = {"tool_name": "Bash", "tool_input": {"command": "git commit -am x"}}
            result = run_hook(repo.path, payload)

            self.assertEqual(result.returncode, 2)
            self.assertIn("probeThresholdValue", result.stderr)

    def test_still_checks_when_the_spec_drops_numbered_headings(self):
        with Repo() as repo:
            write(repo.path, "lib/user.dart", "/// 詳細は §2.3 を見る。\nclass User {}\n")
            repo.commit("cite 2.3")
            write(repo.path, "docs/spec/route-optimization.md", "## Purpose\n\n## Data sources\n")
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("§2.3", result.stderr)

    def test_treats_the_old_side_of_a_rename_as_a_deleted_path(self):
        """`git mv` は R として報告されるので、削除フィルタだけでは旧パスを取り逃す。"""
        with Repo() as repo:
            write(repo.path, "lib/user.dart", "/// 詳細は lib/probe.dart を見る。\nclass User {}\n")
            repo.commit("cite probe path")
            git(repo.path, "mv", "lib/probe.dart", "lib/renamed.dart")
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("lib/probe.dart", result.stderr)

    def test_resolves_a_relative_markdown_link_before_checking_it(self):
        with Repo() as repo:
            write(repo.path, "docs/adr/a.md", "詳細は [spec](../spec/gone.md) を見る。\n")
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("docs/spec/gone.md", result.stderr)

    def test_checks_a_spec_section_cited_from_markdown_that_links_to_it(self):
        with Repo() as repo:
            write(
                repo.path,
                "docs/adr/a.md",
                "[spec](../spec/route-optimization.md) §9.9 が正本。\n",
            )
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("§9.9", result.stderr)

    def test_leaves_a_documents_own_section_numbers_alone(self):
        with Repo() as repo:
            write(repo.path, "docs/ops/o.md", "## 6.1 アラート\n\n詳細は §6.1 を見る。\n")
            repo.stage_all()

            self.assertEqual(run_hook(repo.path).returncode, 0)

    def test_rejects_a_section_item_that_does_not_exist(self):
        with Repo() as repo:
            write(repo.path, "lib/user.dart", "/// 詳細は §2.3-99 を見る。\nclass User {}\n")
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("2.3", result.stderr)

    def test_accepts_a_section_item_that_exists(self):
        with Repo() as repo:
            write(
                repo.path,
                "docs/spec/route-optimization.md",
                "## 1. 目的\n\n## 2. データ源\n\n### 2.3 コリドー\n\n1. 一つ目\n2. 二つ目\n",
            )
            write(repo.path, "lib/user.dart", "/// 詳細は §2.3-2 を見る。\nclass User {}\n")
            repo.stage_all()

            self.assertEqual(run_hook(repo.path).returncode, 0)

    def test_checks_comments_in_test_sources_too(self):
        with Repo() as repo:
            write(repo.path, "test/a_test.dart", "// See lib/missing.dart\nvoid main() {}\n")
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("lib/missing.dart", result.stderr)

    def test_stays_out_of_the_way_of_bash_commands_that_are_not_commits(self):
        with Repo() as repo:
            (repo.path / "lib/probe.dart").unlink()
            repo.stage_all()

            payload = {"tool_name": "Bash", "tool_input": {"command": "git status --short"}}

            self.assertEqual(run_hook(repo.path, payload).returncode, 0)


if __name__ == "__main__":
    unittest.main()
