#!/usr/bin/env python3
"""PostToolUse hook: 編集した TypeScript ファイルのパッケージを型検査し、そのファイルを
oxlint にかけて、エラーを返す。

exit 2 の stderr は Claude に渡る（PostToolUse では編集を取り消さず、知らせるだけ）。
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

PACKAGES = ("apps/web", "packages/engine", "functions")
EXTENSIONS = (".ts", ".tsx")
# functions/lib は tsc の出力先。そこを検査対象にすると出力を検査し続けることになる。
IGNORED_DIRS = ("node_modules", "lib", "dist")
MAX_LINES = 20


def package_for(file_path, root):
    try:
        relative = Path(file_path).resolve().relative_to(Path(root).resolve())
    except ValueError:
        return None
    if relative.suffix not in EXTENSIONS:
        return None
    for package in PACKAGES:
        package_parts = Path(package).parts
        if relative.parts[: len(package_parts)] != package_parts:
            continue
        inner = relative.parts[len(package_parts):]
        if inner and inner[0] in IGNORED_DIRS:
            return None
        return package
    return None


def summarize(output, edited_relative):
    errors = [line for line in output.splitlines() if ": error TS" in line]
    own = [line for line in errors if line.startswith(edited_relative + "(")]
    # 編集したファイルが通っても、型を変えたせいで呼び出し側が壊れていることがある。
    # そのときは他ファイルのエラーこそが知らせるべき内容になる。
    shown = own or errors
    others = len(errors) - len(own) if own else 0
    lines = shown[:MAX_LINES]
    hidden = len(shown) - len(lines)
    footer = []
    if hidden:
        footer.append(f"…ほか {hidden} 件")
    if others:
        footer.append(f"他のファイルにも {others} 件のエラー")
    summary = "\n".join(lines)
    if footer:
        summary += "\n" + "（" + "、".join(footer) + "）"
    return summary


# oxlint の unix 形式の1件。末尾の [Error] は規則を持たない検出（使われない抑止など）。
LINT_FINDING_RE = re.compile(r"\[(Error|Warning)(/[^\]]+)?\]$")


def summarize_lint(output):
    findings = [line for line in output.splitlines() if LINT_FINDING_RE.search(line)]
    lines = findings[:MAX_LINES]
    hidden = len(findings) - len(lines)
    summary = "\n".join(lines)
    if hidden:
        summary += f"\n（…ほか {hidden} 件）"
    return summary


def lint_command(package_dir, edited_relative):
    # パッケージ全体ではなく編集したファイルだけを見る。型情報は tsconfig から引くので、
    # 1ファイルでも型付きの規則は効く。フラグは package.json の lint スクリプトと揃える。
    return [
        str(package_dir / "node_modules" / ".bin" / "oxlint"),
        "--type-aware",
        "--deny-warnings",
        "--report-unused-disable-directives-severity=error",
        "--format",
        "unix",
        edited_relative,
    ]


def run_typecheck(package_dir, edited_relative):
    tsc = package_dir / "node_modules" / ".bin" / "tsc"
    if not tsc.exists():
        # 依存未導入の環境で毎回失敗を返すと、編集のたびに雑音になる。
        return ""
    try:
        result = subprocess.run(
            [str(tsc), "--noEmit", "--pretty", "false"],
            cwd=package_dir, capture_output=True, text=True, timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    if result.returncode == 0:
        return ""
    return summarize(result.stdout + result.stderr, edited_relative)


def run_lint(package_dir, edited_relative):
    command = lint_command(package_dir, edited_relative)
    if not Path(command[0]).exists():
        return ""
    try:
        result = subprocess.run(
            command, cwd=package_dir, capture_output=True, text=True, timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    if result.returncode == 0:
        return ""
    return summarize_lint(result.stdout + result.stderr)


def main():
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)

    root = os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or "."
    file_path = payload.get("tool_input", {}).get("file_path")
    if not isinstance(file_path, str):
        sys.exit(0)
    package = package_for(file_path, root)
    if package is None:
        sys.exit(0)

    package_dir = Path(root) / package
    edited_relative = Path(file_path).resolve().relative_to(package_dir.resolve()).as_posix()
    reports = []
    type_errors = run_typecheck(package_dir, edited_relative)
    if type_errors:
        reports.append(f"[TYPECHECK] {package} で型エラー:\n{type_errors}")
    lint_errors = run_lint(package_dir, edited_relative)
    if lint_errors:
        reports.append(f"[LINT] {package}/{edited_relative} で Lint の違反:\n{lint_errors}")
    if not reports:
        sys.exit(0)
    sys.stderr.write("\n".join(reports) + "\n")
    sys.exit(2)


if __name__ == "__main__":
    main()
