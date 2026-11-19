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


class SummarizeLintTest(unittest.TestCase):
    OUTPUT = "\n".join([
        "src/a.ts:3:3: Promises must be awaited. [Error/typescript(no-floating-promises)]",
        "src/a.ts:9:7: Unused oxlint-disable directive (no problems were reported). [Error]",
        "",
        "2 problems",
    ])

    def test_lists_findings_and_drops_the_tally(self):
        summary = hook.summarize_lint(self.OUTPUT)
        self.assertIn("no-floating-promises", summary)
        self.assertIn("Unused oxlint-disable directive", summary)
        self.assertNotIn("2 problems", summary)

    def test_is_empty_when_nothing_was_found(self):
        self.assertEqual(hook.summarize_lint("Found 0 warnings and 0 errors.\n"), "")

    def test_caps_the_number_of_lines(self):
        many = "\n".join(f"src/a.ts:{i}:1: x [Error/eslint(eqeqeq)]" for i in range(100))
        summary = hook.summarize_lint(many)
        self.assertLessEqual(len(summary.splitlines()), hook.MAX_LINES + 1)
        self.assertIn("80", summary.splitlines()[-1])


class LintCommandTest(unittest.TestCase):
    def test_lints_only_the_edited_file_with_type_information(self):
        command = hook.lint_command(Path("/repo/apps/web"), "src/a.tsx")
        self.assertEqual(command[0], "/repo/apps/web/node_modules/.bin/oxlint")
        self.assertIn("--type-aware", command)
        self.assertEqual(command[-1], "src/a.tsx")

    def test_reports_unused_suppressions_like_the_package_script(self):
        command = hook.lint_command(Path("/repo/functions"), "src/index.ts")
        self.assertIn("--report-unused-disable-directives-severity=error", command)


class PolicyTargetTest(unittest.TestCase):
    def test_checks_code_in_packages_and_markdown_anywhere(self):
        self.assertEqual(hook.policy_target(ROOT / "apps/web/src/main.tsx", ROOT), "apps/web/src/main.tsx")
        self.assertEqual(hook.policy_target(ROOT / "apps/web/scripts/replay.mjs", ROOT), "apps/web/scripts/replay.mjs")
        self.assertEqual(hook.policy_target(ROOT / "docs/new.md", ROOT), "docs/new.md")
        self.assertEqual(hook.policy_target(ROOT / "README.md", ROOT), "README.md")

    def test_ignores_other_files_and_files_outside_the_repo(self):
        self.assertIsNone(hook.policy_target(ROOT / ".claude/guard.py", ROOT))
        self.assertIsNone(hook.policy_target(ROOT / "apps/web/node_modules/x/index.ts", ROOT))
        self.assertIsNone(hook.policy_target(Path("/elsewhere/a.ts"), ROOT))

    def test_runs_the_same_check_as_ci_on_the_edited_file_only(self):
        self.assertEqual(
            hook.policy_command("docs/new.md"),
            ["npm", "run", "--silent", "lint:policy", "--", "--paths", "docs/new.md"],
        )


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
