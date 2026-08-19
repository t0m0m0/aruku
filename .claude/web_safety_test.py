#!/usr/bin/env python3
"""Tests for the web-safety checks (#359 Phase 3)."""

import importlib.util
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


def _load():
    path = Path(__file__).with_name("web_safety.py")
    spec = importlib.util.spec_from_file_location("web_safety", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


ws = _load()
SCRIPT = str(Path(ws.__file__))
REPO = Path(__file__).resolve().parent.parent


def write(root, rel, text):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(textwrap.dedent(text), encoding="utf-8")


def check(root):
    """Run the checker over a tree and return (exit code, combined output)."""
    r = subprocess.run(
        [sys.executable, SCRIPT], text=True, capture_output=True, cwd=str(root), check=False
    )
    return r.returncode, r.stdout + r.stderr


class Tree:
    """A throwaway tree shaped like this project's lib/."""

    def __enter__(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name)
        return self

    def __exit__(self, *exc):
        self._tmp.cleanup()

    def write(self, rel, text):
        write(self.path, rel, text)


class DartIoImports(unittest.TestCase):
    def test_allowlisted_file_may_import_dart_io(self):
        with Tree() as t:
            t.write("lib/main.dart", "import 'dart:io' show Platform;\n")
            code, out = check(t.path)
            self.assertEqual(code, 0, out)

    def test_allowlisted_file_must_restrict_with_show(self):
        # show 無しは dart:io 全体が見えるため、File などが後から静かに入り込む。
        with Tree() as t:
            t.write("lib/main.dart", "import 'dart:io';\n")
            code, out = check(t.path)
            self.assertEqual(code, 1, out)

    def test_allowlisted_file_may_not_widen_its_show_clause(self):
        with Tree() as t:
            t.write("lib/main.dart", "import 'dart:io' show Platform, File;\n")
            code, out = check(t.path)
            self.assertEqual(code, 1, out)
            self.assertIn("File", out)

    def test_allowlisted_file_may_narrow_its_show_clause(self):
        with Tree() as t:
            t.write(
                "lib/core/models/route_error.dart",
                "import 'dart:io' show IOException;\n",
            )
            code, out = check(t.path)
            self.assertEqual(code, 0, out)

    def test_new_file_importing_dart_io_is_rejected(self):
        with Tree() as t:
            t.write("lib/core/services/uploader.dart", "import 'dart:io';\n")
            code, out = check(t.path)
            self.assertEqual(code, 1, out)
            self.assertIn("lib/core/services/uploader.dart", out)

    def test_multiline_import_is_still_checked(self):
        # dart format は show 句が長いと改行する。`;` が別行にあっても素通りさせない。
        with Tree() as t:
            t.write(
                "lib/core/services/uploader.dart",
                "import 'dart:io'\n    show File, Directory;\n",
            )
            code, out = check(t.path)
            self.assertEqual(code, 1, out)
            self.assertIn("lib/core/services/uploader.dart", out)

    def test_multiline_import_in_allowlisted_file_is_validated(self):
        with Tree() as t:
            t.write(
                "lib/main.dart",
                "import 'dart:io'\n    show Platform, File;\n",
            )
            code, out = check(t.path)
            self.assertEqual(code, 1, out)
            self.assertIn("File", out)

    def test_reexporting_dart_io_is_rejected(self):
        # barrel が re-export すると、import 側には dart:io が現れない。
        with Tree() as t:
            t.write("lib/core/io.dart", "export 'dart:io';\n")
            code, out = check(t.path)
            self.assertEqual(code, 1, out)
            self.assertIn("lib/core/io.dart", out)

    def test_dart_io_in_a_comment_is_not_an_import(self):
        with Tree() as t:
            t.write("lib/core/note.dart", "// import 'dart:io'; は Web で使えない。\n")
            code, out = check(t.path)
            self.assertEqual(code, 0, out)


class PlatformEvaluation(unittest.TestCase):
    def test_thunk_is_allowed(self):
        with Tree() as t:
            t.write("lib/main.dart", "final x = useHealthKit(isWeb: kIsWeb, isIOS: () => Platform.isIOS);\n")
            code, out = check(t.path)
            self.assertEqual(code, 0, out)

    def test_kisweb_guard_on_the_same_line_is_allowed(self):
        with Tree() as t:
            t.write("lib/main.dart", "final x = !kIsWeb && Platform.isAndroid;\n")
            code, out = check(t.path)
            self.assertEqual(code, 0, out)

    def test_positive_kisweb_guard_is_rejected(self):
        # `if (kIsWeb) Platform.isAndroid` は Web でこそ評価される。短絡もしない。
        with Tree() as t:
            t.write("lib/main.dart", "void f() { if (kIsWeb) Platform.isAndroid; }\n")
            code, out = check(t.path)
            self.assertEqual(code, 1, out)

    def test_short_circuiting_or_guard_is_allowed(self):
        with Tree() as t:
            t.write("lib/main.dart", "final x = kIsWeb || Platform.isAndroid;\n")
            code, out = check(t.path)
            self.assertEqual(code, 0, out)

    def test_every_occurrence_on_a_line_is_checked(self):
        # 1つ目が守られていても、2つ目が素通りしてはいけない。
        with Tree() as t:
            t.write(
                "lib/main.dart",
                "final x = f(() => Platform.isIOS, Platform.isAndroid);\n",
            )
            code, out = check(t.path)
            self.assertEqual(code, 1, out)

    def test_thunk_for_another_argument_does_not_protect(self):
        # `() =>` は別の引数のもの。Platform は素で評価される。
        with Tree() as t:
            t.write(
                "lib/main.dart",
                "final x = consume(() => false, Platform.isAndroid);\n",
            )
            code, out = check(t.path)
            self.assertEqual(code, 1, out)

    def test_guard_in_a_previous_statement_does_not_protect(self):
        with Tree() as t:
            t.write(
                "lib/main.dart",
                "void f() { final x = !kIsWeb && safe(); Platform.isAndroid; }\n",
            )
            code, out = check(t.path)
            self.assertEqual(code, 1, out)

    def test_immediately_invoked_thunk_is_rejected(self):
        # 直後に呼ぶサンクは遅延しない。Web でその場で評価される。
        with Tree() as t:
            t.write("lib/main.dart", "final x = (() => Platform.isAndroid)();\n")
            code, out = check(t.path)
            self.assertEqual(code, 1, out)

    def test_thunk_wrapped_onto_the_next_line_is_allowed(self):
        # dart format は長い式を折る。推奨している書き方を誤検知してはいけない。
        with Tree() as t:
            t.write(
                "lib/main.dart",
                "final x = useHealthKit(\n  isWeb: kIsWeb,\n  isIOS: () =>\n      Platform.isIOS,\n);\n",
            )
            code, out = check(t.path)
            self.assertEqual(code, 0, out)

    def test_bare_platform_evaluation_is_rejected(self):
        with Tree() as t:
            t.write("lib/main.dart", "final x = Platform.isAndroid;\n")
            code, out = check(t.path)
            self.assertEqual(code, 1, out)
            self.assertIn("lib/main.dart:1", out)

    def test_platform_in_a_doc_comment_is_ignored(self):
        with Tree() as t:
            t.write("lib/main.dart", "/// Web では `Platform.isIOS` の評価自体が投げる。\nconst int a = 1;\n")
            code, out = check(t.path)
            self.assertEqual(code, 0, out)

    def test_platform_in_a_block_comment_is_ignored(self):
        with Tree() as t:
            t.write("lib/main.dart", "/* Platform.isIOS は Web で投げる */\nconst int a = 1;\n")
            code, out = check(t.path)
            self.assertEqual(code, 0, out)

    def test_target_platform_is_not_dart_io_platform(self):
        with Tree() as t:
            t.write("lib/firebase_options.dart", "final x = TargetPlatform.android;\n")
            code, out = check(t.path)
            self.assertEqual(code, 0, out)

    def test_generated_l10n_is_out_of_scope(self):
        with Tree() as t:
            t.write("lib/l10n/app_localizations.dart", "final x = Platform.isAndroid;\n")
            code, out = check(t.path)
            self.assertEqual(code, 0, out)

    def test_url_in_a_string_does_not_hide_a_violation(self):
        with Tree() as t:
            t.write("lib/main.dart", "final u = 'https://example.com'; final x = Platform.isAndroid;\n")
            code, out = check(t.path)
            self.assertEqual(code, 1, out)


class ThisRepository(unittest.TestCase):
    """The guard must pass on HEAD — that is the baseline it protects."""

    def test_repository_is_web_safe(self):
        code, out = check(REPO)
        self.assertEqual(code, 0, out)


if __name__ == "__main__":
    unittest.main()
