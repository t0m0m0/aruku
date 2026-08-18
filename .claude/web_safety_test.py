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

    def test_new_file_importing_dart_io_is_rejected(self):
        with Tree() as t:
            t.write("lib/core/services/uploader.dart", "import 'dart:io';\n")
            code, out = check(t.path)
            self.assertEqual(code, 1, out)
            self.assertIn("lib/core/services/uploader.dart", out)

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
