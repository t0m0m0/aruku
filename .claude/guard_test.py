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
        payload = {"tool_input": {"file_path": "lib/main.dart"}}

        self.assertEqual(guard.extract_file_paths(payload), ["lib/main.dart"])

    def test_extracts_all_paths_from_a_codex_apply_patch_command(self):
        payload = {
            "tool_input": {
                "command": """*** Begin Patch
*** Update File: lib/main.dart
@@
*** Add File: test/main_test.dart
*** Delete File: .env
*** Update File: lib/old_name.dart
*** Move to: lib/new_name.dart
*** End Patch"""
            }
        }

        self.assertEqual(
            guard.extract_file_paths(payload),
            [
                "lib/main.dart",
                "test/main_test.dart",
                ".env",
                "lib/old_name.dart",
                "lib/new_name.dart",
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


if __name__ == "__main__":
    unittest.main()
