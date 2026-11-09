#!/usr/bin/env python3
"""Tests for the PostToolUse hook that type-checks the package of an edited file."""

import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path("/repo")


def _load_module():
    path = Path(__file__).with_name("typecheck_on_edit.py")
    spec = importlib.util.spec_from_file_location("typecheck_on_edit", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


hook = _load_module()


class PackageForTest(unittest.TestCase):
    def test_maps_typescript_files_to_their_package(self):
        self.assertEqual(hook.package_for(ROOT / "apps/web/src/main.tsx", ROOT), "apps/web")
        self.assertEqual(hook.package_for(ROOT / "packages/engine/test/a.test.ts", ROOT), "packages/engine")
        self.assertEqual(hook.package_for(ROOT / "functions/src/index.ts", ROOT), "functions")

    def test_ignores_non_typescript_and_files_outside_packages(self):
        self.assertIsNone(hook.package_for(ROOT / "apps/web/src/index.css", ROOT))
        self.assertIsNone(hook.package_for(ROOT / "docs/spec/route-optimization.md", ROOT))
        self.assertIsNone(hook.package_for(ROOT / "scripts/x.ts", ROOT))
        self.assertIsNone(hook.package_for(Path("/elsewhere/apps/web/a.ts"), ROOT))

    def test_ignores_build_output(self):
        self.assertIsNone(hook.package_for(ROOT / "functions/lib/index.ts", ROOT))


class SummarizeTest(unittest.TestCase):
    OUTPUT = "\n".join([
        "src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.",
        "src/b.ts(3,1): error TS2304: Cannot find name 'y'.",
        "src/b.ts(4,1): error TS2304: Cannot find name 'z'.",
    ])

    def test_lists_errors_of_the_edited_file_and_counts_the_rest(self):
        summary = hook.summarize(self.OUTPUT, "src/a.ts")
        self.assertIn("src/a.ts(1,14)", summary)
        self.assertNotIn("src/b.ts(3,1)", summary)
        self.assertIn("2", summary.splitlines()[-1])

    def test_lists_other_files_when_the_edit_broke_its_callers(self):
        summary = hook.summarize(self.OUTPUT, "src/c.ts")
        self.assertIn("src/b.ts(3,1)", summary)

    def test_caps_the_number_of_lines(self):
        many = "\n".join(f"src/a.ts({i},1): error TS1: x" for i in range(100))
        self.assertLessEqual(len(hook.summarize(many, "src/a.ts").splitlines()), hook.MAX_LINES + 1)


class HookProtocolTest(unittest.TestCase):
    def test_skips_files_it_does_not_check(self):
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("typecheck_on_edit.py"))],
            input=json.dumps({"tool_input": {"file_path": "/repo/README.md"}, "cwd": "/repo"}),
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
