#!/usr/bin/env python3
"""Tests for the paths extracted from Claude Code and Codex hook payloads."""

import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path


def _load_guard_module():
    guard_path = Path(__file__).with_name("guard.py")
    spec = importlib.util.spec_from_file_location("guard", guard_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


guard = _load_guard_module()


class ExtractFilePathsTest(unittest.TestCase):
    def test_uses_claude_code_file_path(self):
        payload = {"tool_input": {"file_path": "apps/web/src/main.tsx"}}

        self.assertEqual(guard.extract_file_paths(payload), ["apps/web/src/main.tsx"])

    def test_extracts_all_paths_from_a_codex_apply_patch_command(self):
        payload = {
            "tool_input": {
                "command": """*** Begin Patch
*** Update File: apps/web/src/main.tsx
@@
*** Add File: apps/web/test/main.test.tsx
*** Delete File: .env
*** Update File: apps/web/src/old-name.ts
*** Move to: apps/web/src/new-name.ts
*** End Patch"""
            }
        }

        self.assertEqual(
            guard.extract_file_paths(payload),
            [
                "apps/web/src/main.tsx",
                "apps/web/test/main.test.tsx",
                ".env",
                "apps/web/src/old-name.ts",
                "apps/web/src/new-name.ts",
            ],
        )

    def test_rejects_a_codex_command_without_file_headers(self):
        payload = {"tool_input": {"command": "*** Begin Patch\n*** End Patch"}}

        result = subprocess.run(
            [sys.executable, str(Path(guard.__file__))],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(result.returncode, 2)
        self.assertIn("特定できない", result.stderr)


def run_guard(file_path):
    return subprocess.run(
        [sys.executable, str(Path(guard.__file__))],
        input=json.dumps({"tool_input": {"file_path": file_path}}),
        text=True,
        capture_output=True,
        check=False,
    )


class DependencyManifestTest(unittest.TestCase):
    def test_blocks_edits_to_npm_manifests(self):
        for path in [
            "/repo/apps/web/package.json",
            "/repo/packages/engine/package-lock.json",
            "functions/package.json",
        ]:
            with self.subTest(path=path):
                self.assertEqual(run_guard(path).returncode, 2)

    def test_allows_files_that_only_look_similar(self):
        for path in ["/repo/apps/web/src/package-json.ts", "/repo/docs/package.json.md"]:
            with self.subTest(path=path):
                self.assertEqual(run_guard(path).returncode, 0)


if __name__ == "__main__":
    unittest.main()
