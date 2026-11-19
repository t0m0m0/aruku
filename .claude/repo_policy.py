#!/usr/bin/env python3
"""PreToolUse/Bash hook: `git commit` の前に、コメントと許可外の Markdown の検査（#528）を走らせる。

検査するのは commit される中身。通常は index（staged）を見て、`-a` / `--include` / `--only` のように
作業ツリーを取り込む commit のときだけ作業ツリーを見る。

検査の本体は functions/scripts/repo-policy/（CI の repo-policy ジョブと同じもの）。違反があれば
exit 2 で commit を止め、一覧を Claude に返す。
"""

import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

# `git <ここ> commit` に置ける、値を1つ取るグローバルオプション。値と取り違えると
# `git -C commit status` を commit と誤検出する。
GIT_OPTIONS_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"}
SEPARATORS = {"&&", "||", ";", "|", "&"}


COMMIT_SHORT_OPTIONS_WITH_VALUE = set("mFCct")
COMMIT_LONG_OPTIONS_WITH_VALUE = {
    "--message", "--file", "--reuse-message", "--reedit-message", "--template",
    "--author", "--date", "--fixup", "--squash", "--cleanup", "--trailer", "--pathspec-from-file",
}
HEREDOC_RE = re.compile(r"<<-?\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?")


def _command_lines(command):
    heredoc_end = None
    for line in command.split("\n"):
        if heredoc_end is not None:
            if line.strip() == heredoc_end:
                heredoc_end = None
            continue
        match = HEREDOC_RE.search(line)
        if match:
            heredoc_end = match.group(1)
            line = line[: match.start()]
        yield line


def _segments(command):
    for line in _command_lines(command):
        lexer = shlex.shlex(line, posix=True, punctuation_chars=";&|")
        lexer.whitespace_split = True
        try:
            tokens = list(lexer)
        except ValueError:
            tokens = line.split()
        segment = []
        for token in tokens:
            if token in SEPARATORS:
                if segment:
                    yield segment
                segment = []
            else:
                segment.append(token)
        if segment:
            yield segment


def _commit_args(command):
    for tokens in _segments(command):
        if not tokens or tokens[0] != "git":
            continue
        i = 1
        while i < len(tokens) and tokens[i].startswith("-"):
            i += 2 if tokens[i] in GIT_OPTIONS_WITH_VALUE else 1
        if i < len(tokens) and tokens[i] == "commit":
            return tokens[i + 1 :]
    return None


def is_git_commit(command):
    return _commit_args(command) is not None


def _takes_worktree(args):
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--all", "--include", "--only") or not arg.startswith("-") or arg == "--":
            return True
        if arg.startswith("--"):
            if arg in COMMIT_LONG_OPTIONS_WITH_VALUE:
                i += 1
        elif arg.startswith("-") and len(arg) > 1:
            for position, flag in enumerate(arg[1:]):
                if flag in "aio":
                    return True
                if flag in COMMIT_SHORT_OPTIONS_WITH_VALUE:
                    if position == len(arg) - 2:
                        i += 1
                    break
        i += 1
    return False


def policy_command(command):
    base = ["npm", "run", "--silent", "lint:policy"]
    args = _commit_args(command) or []
    return base if _takes_worktree(args) else base + ["--", "--staged"]


def main():
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)
    command = payload.get("tool_input", {}).get("command")
    if not isinstance(command, str) or not is_git_commit(command):
        sys.exit(0)

    root = Path(os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or ".")
    try:
        result = subprocess.run(
            policy_command(command),
            cwd=root / "functions", capture_output=True, text=True, timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as error:
        sys.stderr.write(f"[REPO-POLICY] 検査を走らせられませんでした: {error}\n")
        sys.exit(2)
    if result.returncode == 0:
        sys.exit(0)
    sys.stderr.write("[REPO-POLICY] コメントか許可外の Markdown があります（#528）:\n" + result.stderr)
    sys.exit(2)


if __name__ == "__main__":
    main()
