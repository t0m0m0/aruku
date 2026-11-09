#!/usr/bin/env python3
"""Tests for the dangerous-command guard on Bash tool calls."""

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


def _load_module():
    path = Path(__file__).with_name("bash_guard.py")
    spec = importlib.util.spec_from_file_location("bash_guard", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


bash_guard = _load_module()


class DenyReasonTest(unittest.TestCase):
    def deny(self, command, branch="feat/1-x"):
        return bash_guard.deny_reason(command, branch)

    def test_allows_ordinary_commands(self):
        self.assertIsNone(self.deny("npm test"))
        self.assertIsNone(self.deny("git commit -m 'feat(#1): x'"))
        self.assertIsNone(self.deny("git push -u origin feat/1-x"))

    def test_rejects_long_and_short_force_push(self):
        self.assertIsNotNone(self.deny("git push --force origin feat/1-x"))
        self.assertIsNotNone(self.deny("git push -f origin feat/1-x"))
        self.assertIsNotNone(self.deny("git push origin +feat/1-x"))

    def test_rejects_commit_while_on_main(self):
        self.assertIsNotNone(self.deny("git commit -m 'x'", branch="main"))
        self.assertIsNotNone(self.deny("git add . && git commit -m x", branch="main"))

    def test_rejects_push_targeting_main_from_any_branch(self):
        self.assertIsNotNone(self.deny("git push origin main"))
        self.assertIsNotNone(self.deny("git push origin HEAD:main"))
        self.assertIsNotNone(self.deny("git push", branch="main"))

    def test_does_not_mistake_main_in_a_commit_message_for_a_push_target(self):
        self.assertIsNone(self.deny("git commit -m 'main の画面を直す'"))
        self.assertIsNone(self.deny("git push -u origin feat/1-main-screen"))

    def test_rejects_reading_env_files_through_the_shell(self):
        self.assertIsNotNone(self.deny("cat .env"))
        self.assertIsNotNone(self.deny("cat apps/web/.env.local"))
        self.assertIsNotNone(self.deny("grep KEY apps/web/.env"))

    def test_does_not_treat_env_in_a_commit_message_or_issue_body_as_access(self):
        self.assertIsNone(self.deny("git commit -m 'fix: .env の Read を拒否する'"))
        self.assertIsNone(self.deny("gh api repos/o/r/issues -f body='.env を読まない'"))
        self.assertIsNotNone(self.deny("git commit -m x && cat .env"))

    def test_still_checks_arguments_that_read_a_file_into_the_message_or_body(self):
        self.assertIsNotNone(self.deny("git commit -F .env"))
        self.assertIsNotNone(self.deny("git commit --file=apps/web/.env"))
        self.assertIsNotNone(self.deny("gh api repos/o/r/issues -F body=@.env"))
        self.assertIsNotNone(self.deny("gh issue create --body-file .env"))
        self.assertIsNotNone(self.deny("git commit -m x < .env"))

    def test_still_checks_command_substitutions_inside_a_message(self):
        self.assertIsNotNone(self.deny('git commit -m "$(cat .env)"'))
        self.assertIsNotNone(self.deny('git commit -m "`cat .env`"'))
        self.assertIsNotNone(self.deny('gh api repos/o/r/issues -f body="$(cat apps/web/.env)"'))

    def test_allows_a_message_built_from_a_quoted_heredoc(self):
        command = "git commit -m \"$(cat <<'EOF'\nfix: .env の Read を拒否する\nEOF\n)\""
        self.assertIsNone(self.deny(command))

    def test_sees_through_leading_assignments_and_wrappers(self):
        self.assertIsNotNone(self.deny('GIT_SSH_COMMAND="ssh -i key" git push --force origin topic'))
        self.assertIsNotNone(self.deny("env GIT_TRACE=1 git push -f origin topic"))
        self.assertIsNotNone(self.deny("A=1 B=2 git commit -m x", branch="main"))

    def test_treats_unquoted_newlines_as_command_separators(self):
        self.assertIsNotNone(self.deny("git status\ngit commit -m x", branch="main"))
        self.assertIsNotNone(self.deny("echo starting\ngit push --force origin topic"))
        self.assertIsNotNone(self.deny("git commit -m x\ncat .env"))

    def test_keeps_a_quoted_multiline_message_as_one_argument(self):
        self.assertIsNone(self.deny("git commit -m 'feat: x\n\ngit push -f の説明'"))

    def test_allows_env_example_and_similarly_named_paths(self):
        self.assertIsNone(self.deny("cat apps/web/.env.example"))
        self.assertIsNone(self.deny("ls src/.environment"))


class CurrentBranchTest(unittest.TestCase):
    def test_reads_the_branch_of_the_hook_cwd(self):
        with tempfile.TemporaryDirectory() as repo:
            subprocess.run(["git", "init", "-q", "-b", "topic", repo], check=True)
            self.assertEqual(bash_guard.current_branch(repo), "topic")

    def test_outside_a_repository_has_no_branch(self):
        with tempfile.TemporaryDirectory() as plain:
            self.assertIsNone(bash_guard.current_branch(plain))


class HookProtocolTest(unittest.TestCase):
    def run_hook(self, payload):
        return subprocess.run(
            [sys.executable, str(Path(__file__).with_name("bash_guard.py"))],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
        )

    def test_blocks_with_exit_2_and_a_reason(self):
        result = self.run_hook({"tool_input": {"command": "git push -f"}, "cwd": "/"})
        self.assertEqual(result.returncode, 2)
        self.assertIn("[GUARD]", result.stderr)

    def test_passes_with_exit_0(self):
        result = self.run_hook({"tool_input": {"command": "ls"}, "cwd": "/"})
        self.assertEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
