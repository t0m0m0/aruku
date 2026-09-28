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
    """A throwaway git repo shaped like this project (apps/ + packages/ + docs/spec/)."""

    def __enter__(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name)
        git(self.path, "init", "-q")
        git(self.path, "config", "user.email", "t@t")
        git(self.path, "config", "user.name", "t")
        write(self.path, "docs/spec/route-optimization.md", "## 1. 目的\n\n## 2. データ源\n\n### 2.3 コリドー\n")
        write(self.path, "packages/engine/src/probe.ts", "export const probeThresholdValue = 3;\n")
        write(self.path, "apps/web/src/user.ts", "/// 判定は [probeThresholdValue] を境目にする。\nexport class User {}\n")
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
        diff = "--- a/packages/engine/src/probe.ts\n-export const probeThresholdValue = 3;\n"

        self.assertIn("probeThresholdValue", dc.removed_declarations(diff))

    def test_ignores_declarations_removed_from_languages_it_does_not_scan(self):
        """撤去した言語（Dart）の宣言は、TS のコメントが来歴として名指ししてよい。"""
        diff = (
            "diff --git a/lib/journey.dart b/lib/journey.dart\n"
            "--- a/lib/journey.dart\n"
            "+++ /dev/null\n"
            "-class JourneyProgress {\n"
            "diff --git a/apps/web/src/a.ts b/apps/web/src/a.ts\n"
            "--- a/apps/web/src/a.ts\n"
            "+++ b/apps/web/src/a.ts\n"
            "-export class RouteSummaryCard {\n"
        )

        self.assertEqual(dc.removed_declarations(diff), {"RouteSummaryCard"})

    def test_ignores_deleted_comment_lines(self):
        diff = "-  /// class SomethingDescribed が消えたわけではない\n"

        self.assertEqual(dc.removed_declarations(diff), set())

    def test_picks_up_type_declarations(self):
        for line, expected in [
            ("-export class LocationState {", "LocationState"),
            ("-export abstract class RouteService {", "RouteService"),
            ("-export interface RouteCore {", "RouteCore"),
            ("-export type SearchStatus = 'idle' | 'loading';", "SearchStatus"),
            ("-export async function createRouteService(", "createRouteService"),
        ]:
            with self.subTest(line=line):
                self.assertIn(expected, dc.removed_declarations(line))

    def test_picks_up_class_fields_with_modifiers(self):
        for line, expected in [
            ("-  private readonly boardSearchFanout = 5;", "boardSearchFanout"),
            ("-  private static readonly maxCorridorStops = 12;", "maxCorridorStops"),
            ("-  readonly matrixCalls: number;", "matrixCalls"),
        ]:
            with self.subTest(line=line):
                self.assertIn(expected, dc.removed_declarations(line))

    def test_picks_up_class_methods_and_getters(self):
        for line, expected in [
            ("-  private async fetchTransitEndpoints(", "fetchTransitEndpoints"),
            ("-  async planRoute(input: RouteInput): Promise<RoutePlan> {", "planRoute"),
            ("-  resolveBoardingTimes(", "resolveBoardingTimes"),
            ("-  get matrixCalls(): number {", "matrixCalls"),
            ("-  static fromJson(json: unknown): AppSettings {", "fromJson"),
        ]:
            with self.subTest(line=line):
                self.assertIn(expected, dc.removed_declarations(line))

    def test_picks_up_single_line_interface_method_signatures(self):
        for line, expected in [
            ("-  measureShortlist(input: RouteInput): number;", "measureShortlist"),
            ("-  resolveBoardingTimes?(): Promise<void>;", "resolveBoardingTimes"),
        ]:
            with self.subTest(line=line):
                self.assertIn(expected, dc.removed_declarations(line))

    def test_ignores_local_variables_inside_a_function_body(self):
        """局所名は散文の普通の英単語に当たる。コメントが指すのは API シンボル。"""
        diff = "-    const files = captured?.files ?? [];\n-      const bestIndex = 0;\n"

        self.assertEqual(dc.removed_declarations(diff), set())

    def test_ignores_generic_lowercase_names(self):
        self.assertEqual(dc.removed_declarations("-export const files = 1;"), set())
        self.assertIn("roundTrips", dc.removed_declarations("-  get roundTrips(): number {"))

    def test_does_not_mistake_statements_for_declarations(self):
        for line in [
            "-  return calculateRoute(input);",
            "-  render(<App />);",
            "-  while (isReadyForDeparture()) {",
            "-  throw new RouteExceptionThing('x');",
            "-  await planRoute(input);",
            "-  if (isReadyForDeparture()) {",
            "-  expect(calculateRoute(input)).toBe(3);",
        ]:
            with self.subTest(line=line):
                self.assertEqual(dc.removed_declarations(line), set())


class LineSplitTest(unittest.TestCase):
    def test_separates_comment_lines_from_code_lines(self):
        prose, code = dc.split_lines("// 先頭\nconst x = 1;\n/// doc\n", "apps/web/src/a.ts")

        self.assertEqual([t for _, t in prose], ["// 先頭", "/// doc"])
        self.assertEqual([t.strip() for _, t in code], ["const x = 1;"])

    def test_treats_every_line_of_markdown_as_prose(self):
        prose, code = dc.split_lines("a\nb\n", "docs/x.md")

        self.assertEqual(prose, [(1, "a"), (2, "b")])
        self.assertEqual(code, [])


class JsxCommentTest(unittest.TestCase):
    def test_treats_a_jsx_comment_as_prose(self):
        """コード扱いにすると、コメント中の名前が「まだ使われている」証拠になる。"""
        prose, code = dc.split_lines(
            "{/* dateLabel は親が持つ */}\n<div />\n{/* 複数行の\n   dateLabel */}\n",
            "apps/web/src/a.tsx",
        )

        self.assertEqual([t for _, t in prose], ["{/* dateLabel は親が持つ */}", "{/* 複数行の", "dateLabel */}"])
        self.assertEqual([t.strip() for _, t in code], ["<div />"])


class InlineCommentTest(unittest.TestCase):
    def test_keeps_a_trailing_comment_out_of_the_code_line(self):
        """コード行にコメントが残ると、そのコメントが自分の検出を握り潰す。"""
        prose, code = dc.split_lines("const x = 1; // OldService handled this\n", "apps/web/src/a.ts")

        self.assertEqual([t.strip() for _, t in code], ["const x = 1;"])
        self.assertEqual([t for _, t in prose], ["// OldService handled this"])

    def test_does_not_treat_a_url_inside_a_string_as_a_comment(self):
        _, code = dc.split_lines("const u = 'https://example.com/x';\n", "apps/web/src/a.ts")

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
            "git commit apps/web/src/a.ts", "git commit -p", "git commit --interactive",
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(dc.parse_git_commit(cmd), (True, True))

    def test_does_not_flag_a_plain_staged_commit(self):
        self.assertEqual(dc.parse_git_commit("git commit -m 'apps/web/src/a.ts を直す'"), (True, False))


class PathPatternTest(unittest.TestCase):
    def test_matches_a_path_that_ends_a_sentence(self):
        self.assertEqual(dc.PATH_RE.findall("See lib/core/gone.dart."), ["lib/core/gone.dart"])

    def test_keeps_a_multi_part_extension_whole(self):
        self.assertEqual(
            dc.PATH_RE.findall("see android/app/build.gradle.kts"), ["android/app/build.gradle.kts"]
        )

    def test_ignores_a_package_uri(self):
        self.assertEqual(dc.PATH_RE.findall("import 'package:x/lib/foo.dart';"), [])

    def test_matches_paths_under_the_web_app_and_the_engine(self):
        self.assertEqual(
            dc.PATH_RE.findall("apps/web/src/map/aruku-map.tsx と packages/engine/src/time.ts"),
            ["apps/web/src/map/aruku-map.tsx", "packages/engine/src/time.ts"],
        )

    def test_matches_a_stylesheet_path(self):
        self.assertEqual(
            dc.PATH_RE.findall("apps/web/src/theme/tokens.css を見る"), ["apps/web/src/theme/tokens.css"]
        )

    def test_matches_a_directory_reference(self):
        self.assertEqual(
            dc.PATH_RE.findall("移植元: lib/features/picker/ の入力"), ["lib/features/picker/"]
        )

    def test_ignores_a_path_qualified_by_a_git_revision(self):
        self.assertEqual(dc.PATH_RE.findall("移植元: flutter-final:lib/core/foo.dart"), [])


class HookTest(unittest.TestCase):
    def test_blocks_a_commit_that_removes_a_symbol_still_named_in_a_comment(self):
        with Repo() as repo:
            (repo.path / "packages/engine/src/probe.ts").unlink()
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("probeThresholdValue", result.stderr)

    def test_allows_a_commit_that_moves_the_declaration_elsewhere(self):
        with Repo() as repo:
            (repo.path / "packages/engine/src/probe.ts").unlink()
            write(repo.path, "packages/engine/src/moved.ts", "export const probeThresholdValue = 3;\n")
            repo.stage_all()

            self.assertEqual(run_hook(repo.path).returncode, 0)

    def test_allows_a_commit_that_removes_the_comment_along_with_the_symbol(self):
        with Repo() as repo:
            (repo.path / "packages/engine/src/probe.ts").unlink()
            write(repo.path, "apps/web/src/user.ts", "export class User {}\n")
            repo.stage_all()

            self.assertEqual(run_hook(repo.path).returncode, 0)

    def test_blocks_a_comment_pointing_at_a_path_that_does_not_exist(self):
        with Repo() as repo:
            write(repo.path, "apps/web/src/user.ts", "/// 詳細は apps/web/src/gone.ts を見る。\nexport class User {}\n")
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("apps/web/src/gone.ts", result.stderr)

    def test_blocks_a_comment_citing_a_spec_section_that_does_not_exist(self):
        with Repo() as repo:
            write(repo.path, "apps/web/src/user.ts", "/// 詳細は §9.9 を見る。\nexport class User {}\n")
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("§9.9", result.stderr)

    def test_allows_a_comment_citing_a_spec_section_that_exists(self):
        with Repo() as repo:
            write(repo.path, "apps/web/src/user.ts", "/// 詳細は §2.3 を見る。\nexport class User {}\n")
            repo.stage_all()

            self.assertEqual(run_hook(repo.path).returncode, 0)

    def test_does_not_let_a_stale_comment_vouch_for_its_own_symbol(self):
        """コメント自身が「まだ宣言が在る」判定に当たると、自分の検出を握り潰す。"""
        with Repo() as repo:
            write(repo.path, "apps/web/src/user.ts", "/// class probeThresholdValue が持っていた責務。\nexport class User {}\n")
            (repo.path / "packages/engine/src/probe.ts").unlink()
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("probeThresholdValue", result.stderr)

    def test_does_not_let_a_call_shaped_comment_vouch_for_its_own_symbol(self):
        with Repo() as repo:
            write(repo.path, "apps/web/src/user.ts", "/// 呼ぶときは probeThresholdValue() だった。\nexport class User {}\n")
            (repo.path / "packages/engine/src/probe.ts").unlink()
            repo.stage_all()

            self.assertEqual(run_hook(repo.path).returncode, 2)

    def test_honours_the_keep_marker_for_an_intentional_historical_reference(self):
        with Repo() as repo:
            write(
                repo.path,
                "apps/web/src/user.ts",
                "/// probeThresholdValue は #330 で撤去した。 doc-consistency:keep\nexport class User {}\n",
            )
            (repo.path / "packages/engine/src/probe.ts").unlink()
            repo.stage_all()

            self.assertEqual(run_hook(repo.path).returncode, 0)

    def test_rejects_a_reference_to_a_file_that_is_only_untracked(self):
        """作業ツリーに在るだけの未追跡ファイルは、クリーンな CI では存在しない。"""
        with Repo() as repo:
            write(repo.path, "apps/web/src/new-service.ts", "export class NewService {}\n")
            write(repo.path, "apps/web/src/user.ts", "/// 詳細は apps/web/src/new-service.ts を見る。\nexport class User {}\n")
            git(repo.path, "add", "apps/web/src/user.ts")

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("apps/web/src/new-service.ts", result.stderr)

    def test_rescans_every_code_reference_when_the_spec_is_renumbered(self):
        """節の付け替えは、変えたのが仕様書だけでも他ファイルの §N を腐らせる。"""
        with Repo() as repo:
            write(repo.path, "apps/web/src/user.ts", "/// 詳細は §2.3 を見る。\nexport class User {}\n")
            repo.commit("cite 2.3")
            write(repo.path, "docs/spec/route-optimization.md", "## 1. 目的\n\n## 2. データ源\n\n### 2.4 コリドー\n")
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("§2.3", result.stderr)

    def test_does_not_let_a_trailing_comment_vouch_for_its_own_symbol(self):
        with Repo() as repo:
            write(repo.path, "apps/web/src/user.ts", "export class User {} // probeThresholdValue が持っていた責務\n")
            (repo.path / "packages/engine/src/probe.ts").unlink()
            repo.stage_all()

            self.assertEqual(run_hook(repo.path).returncode, 2)

    def test_inspects_unstaged_content_when_the_commit_would_include_it(self):
        """`git commit -a` はフック実行後に自動 stage する。index だけ見ると素通りする。"""
        with Repo() as repo:
            (repo.path / "packages/engine/src/probe.ts").unlink()  # stage しない

            payload = {"tool_name": "Bash", "tool_input": {"command": "git commit -am x"}}
            result = run_hook(repo.path, payload)

            self.assertEqual(result.returncode, 2)
            self.assertIn("probeThresholdValue", result.stderr)

    def test_still_checks_when_the_spec_drops_numbered_headings(self):
        with Repo() as repo:
            write(repo.path, "apps/web/src/user.ts", "/// 詳細は §2.3 を見る。\nexport class User {}\n")
            repo.commit("cite 2.3")
            write(repo.path, "docs/spec/route-optimization.md", "## Purpose\n\n## Data sources\n")
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("§2.3", result.stderr)

    def test_treats_the_old_side_of_a_rename_as_a_deleted_path(self):
        """`git mv` は R として報告されるので、削除フィルタだけでは旧パスを取り逃す。"""
        with Repo() as repo:
            write(repo.path, "apps/web/src/user.ts", "/// 詳細は packages/engine/src/probe.ts を見る。\nexport class User {}\n")
            repo.commit("cite probe path")
            git(repo.path, "mv", "packages/engine/src/probe.ts", "packages/engine/src/renamed.ts")
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("packages/engine/src/probe.ts", result.stderr)

    def test_flags_a_deleted_file_reached_by_a_relative_link_from_an_unchanged_doc(self):
        """参照元が未変更だと targets に入らない。削除ファイル検査側でも相対リンクを解く。"""
        with Repo() as repo:
            write(repo.path, "docs/spec/foo.md", "x\n")
            write(repo.path, "docs/adr/a.md", "詳細は [spec](../spec/foo.md) を見る。\n")
            repo.commit("add doc pair")
            git(repo.path, "rm", "-q", "docs/spec/foo.md")

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("docs/spec/foo.md", result.stderr)

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
            write(repo.path, "apps/web/src/user.ts", "/// 詳細は §2.3-99 を見る。\nexport class User {}\n")
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
            write(repo.path, "apps/web/src/user.ts", "/// 詳細は §2.3-2 を見る。\nexport class User {}\n")
            repo.stage_all()

            self.assertEqual(run_hook(repo.path).returncode, 0)

    def test_checks_comments_in_test_sources_too(self):
        with Repo() as repo:
            write(repo.path, "packages/engine/test/a.test.ts", "// See packages/engine/src/missing.ts\nexport {};\n")
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("packages/engine/src/missing.ts", result.stderr)

    def test_checks_comments_in_web_app_sources(self):
        with Repo() as repo:
            write(repo.path, "apps/web/src/a.tsx", "// See apps/web/src/missing.ts\nexport const a = 1;\n")
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("apps/web/src/missing.ts", result.stderr)

    def test_checks_comments_in_engine_sources(self):
        with Repo() as repo:
            write(repo.path, "packages/engine/src/a.ts", "// 移植元: lib/missing.dart\nexport const a = 1;\n")
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("lib/missing.dart", result.stderr)

    def test_checks_comments_in_web_app_stylesheets(self):
        with Repo() as repo:
            write(repo.path, "apps/web/src/a.module.css", "/* apps/web/src/gone.tsx と揃える */\n.a {}\n")
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("apps/web/src/gone.tsx", result.stderr)

    def test_checks_the_documents_that_live_next_to_a_package(self):
        with Repo() as repo:
            write(repo.path, "apps/web/PORTING.md", "`packages/engine/src/gone.ts` を参照。\n")
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("packages/engine/src/gone.ts", result.stderr)

    def test_checks_spec_sections_cited_from_web_app_sources(self):
        with Repo() as repo:
            write(repo.path, "apps/web/src/a.ts", "// 詳細は §9.9 を見る。\nexport const a = 1;\n")
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("§9.9", result.stderr)

    def test_blocks_removing_a_typescript_symbol_still_named_in_a_web_comment(self):
        with Repo() as repo:
            write(repo.path, "packages/engine/src/limits.ts", "export const walkBudgetCeiling = 3;\n")
            write(repo.path, "apps/web/src/b.ts", "// walkBudgetCeiling を超えたら打ち切る。\nexport const b = 1;\n")
            repo.commit("ts")
            (repo.path / "packages/engine/src/limits.ts").unlink()
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("walkBudgetCeiling", result.stderr)

    def test_does_not_let_a_root_file_vouch_for_a_deleted_package_file(self):
        with Repo() as repo:
            write(repo.path, "test/a.test.ts", "export {};\n")
            write(repo.path, "apps/web/test/a.test.ts", "export {};\n")
            write(repo.path, "apps/web/PORTING.md", "移植先は `test/a.test.ts`。\n")
            repo.commit("both")
            (repo.path / "apps/web/test/a.test.ts").unlink()
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("test/a.test.ts", result.stderr)

    def test_resolves_a_repository_rooted_path_from_inside_a_package(self):
        with Repo() as repo:
            write(repo.path, "apps/web/src/a.ts", "// docs/spec/route-optimization.md §2.3 を見る。\nexport const a = 1;\n")
            repo.stage_all()

            self.assertEqual(run_hook(repo.path).returncode, 0)

    def test_checks_the_index_from_the_command_line(self):
        """手で回す入口。フック用の JSON を渡さずに、コミット前の index を検査する。"""
        with Repo() as repo:
            (repo.path / "packages/engine/src/probe.ts").unlink()
            repo.stage_all()

            result = subprocess.run(
                [sys.executable, SCRIPT, "--staged"],
                stdin=subprocess.DEVNULL,
                text=True,
                capture_output=True,
                cwd=str(repo.path),
                check=False,
            )

            self.assertEqual(result.returncode, 1)
            self.assertIn("probeThresholdValue", result.stderr)

    def test_flags_a_reference_to_a_directory_whose_files_were_all_deleted(self):
        with Repo() as repo:
            write(repo.path, "apps/web/src/old/a.ts", "export {};\n")
            write(repo.path, "apps/web/src/b.ts", "// 移植元: apps/web/src/old/ の入力\nexport const b = 1;\n")
            repo.commit("dir")
            (repo.path / "apps/web/src/old/a.ts").unlink()
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("apps/web/src/old/", result.stderr)

    def test_accepts_a_directory_reference_that_still_has_files(self):
        with Repo() as repo:
            write(repo.path, "apps/web/src/b.ts", "// 詳細は packages/engine/src/ を見る。\nexport const b = 1;\n")
            repo.stage_all()

            self.assertEqual(run_hook(repo.path).returncode, 0)

    def test_resolves_a_path_relative_to_the_package_that_mentions_it(self):
        with Repo() as repo:
            write(repo.path, "apps/web/test/a.test.ts", "export {};\n")
            write(repo.path, "apps/web/src/a.ts", "// test/a.test.ts が固定する。\nexport const a = 1;\n")
            repo.stage_all()

            self.assertEqual(run_hook(repo.path).returncode, 0)

    def test_blocks_a_package_relative_path_that_exists_nowhere(self):
        with Repo() as repo:
            write(repo.path, "apps/web/src/a.ts", "// test/missing.test.ts が固定する。\nexport const a = 1;\n")
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("test/missing.test.ts", result.stderr)

    def test_flags_a_deleted_file_named_relative_to_its_package(self):
        with Repo() as repo:
            write(repo.path, "packages/engine/test/a.test.ts", "export {};\n")
            write(repo.path, "packages/engine/PORTING.md", "移植先は `test/a.test.ts`。\n")
            repo.commit("pkg")
            (repo.path / "packages/engine/test/a.test.ts").unlink()
            repo.stage_all()

            result = run_hook(repo.path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("test/a.test.ts", result.stderr)

    def test_stays_out_of_the_way_of_bash_commands_that_are_not_commits(self):
        with Repo() as repo:
            (repo.path / "packages/engine/src/probe.ts").unlink()
            repo.stage_all()

            payload = {"tool_name": "Bash", "tool_input": {"command": "git status --short"}}

            self.assertEqual(run_hook(repo.path, payload).returncode, 0)


if __name__ == "__main__":
    unittest.main()
