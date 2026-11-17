#!/usr/bin/env python3
"""PostToolUse hook: 編集したファイルをルートの Prettier で整形する。

整形は黙って行い、何も報告しない（exit 0）。整形できないファイル（構文の壊れたものなど）の
指摘は typecheck_on_edit.py が出す。
"""

import json
import os
import subprocess
import sys
from pathlib import Path


def relative_target(file_path, root):
    try:
        relative = Path(file_path).resolve().relative_to(Path(root).resolve())
    except ValueError:
        return None
    if relative.parts[:1] == (".git",):
        return None
    return relative.as_posix()


def format_command(root, relative):
    # 対象外の判定（拡張子・.prettierignore・ルートの .gitignore）はここで写さず Prettier に
    # 任せる。写すと CI の prettier --check と食い違いうる。
    return [
        str(Path(root) / "node_modules" / ".bin" / "prettier"),
        "--ignore-unknown",
        "--log-level",
        "silent",
        "--write",
        relative,
    ]


def main():
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)

    root = os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or "."
    file_path = payload.get("tool_input", {}).get("file_path")
    if not isinstance(file_path, str):
        sys.exit(0)
    relative = relative_target(file_path, root)
    if relative is None:
        sys.exit(0)

    command = format_command(root, relative)
    if not Path(command[0]).exists():
        # 依存未導入の環境で毎回失敗を返すと、編集のたびに雑音になる。
        sys.exit(0)
    try:
        # ignore ファイルと設定はルートから引くので、ルートで走らせる。
        subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
