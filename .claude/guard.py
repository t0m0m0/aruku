#!/usr/bin/env python3
"""
PreToolUse hook: ファイルアクセスのdenylistガード
Claude Codeがファイルを書き込む前に実行される
exit 2 + stderr出力でClaudeにブロック理由を伝える
"""

import json
import sys
import os
import re

DENY_PATTERNS = [
    # 秘密情報
    r'\.env$',
    r'\.env\..*',
    r'lib/secrets/',
    r'lib/config/secrets',
    r'Secrets.xcconfig$',
    r'secrets.properties$',
    # プラットフォーム固有の認証ファイル
    r'android/app/google-services\.json$',
    r'ios/Runner/GoogleService-Info\.plist$',
    r'ios/Runner/.*\.p12$',
    r'ios/Runner/.*\.mobileprovision$',
    # 依存関係（勝手な変更を防ぐ）
    r'pubspec\.yaml$',
    r'pubspec\.lock$',
    # Gitの設定
    r'\.git/',
    # Claude自身の設定（再帰的な変更を防ぐ）
    r'\.claude/settings\.json$',
    r'\.claude/guard\.py$',
    r'\.claude/bash_guard\.py$',
]


PATCH_PATH_PREFIXES = (
    '*** Update File: ',
    '*** Add File: ',
    '*** Delete File: ',
    '*** Move to: ',
)


def extract_file_paths(input_data):
    """Return every file targeted by a Claude Code or Codex edit payload."""
    tool_input = input_data.get('tool_input', {})
    file_path = tool_input.get('file_path')
    if isinstance(file_path, str) and file_path:
        return [os.path.normpath(file_path)]

    command = tool_input.get('command', '')
    if not isinstance(command, str):
        return []

    paths = []
    for line in command.splitlines():
        for prefix in PATCH_PATH_PREFIXES:
            if line.startswith(prefix):
                path = line[len(prefix):].strip()
                if path:
                    paths.append(os.path.normpath(path))
                break
    return paths


def read_hook_input():
    try:
        return json.load(sys.stdin)
    except json.JSONDecodeError:
        return None


def main():
    input_data = read_hook_input()
    if input_data is None:
        sys.exit(0)

    file_paths = extract_file_paths(input_data)
    if '--paths' in sys.argv:
        if not file_paths:
            sys.stderr.write('[GUARD] パッチから変更対象ファイルを特定できません。\n')
            sys.exit(2)
        print('\n'.join(file_paths))
        sys.exit(0)

    if not file_paths:
        if input_data.get('tool_input', {}).get('command'):
            sys.stderr.write('[GUARD] パッチから変更対象ファイルを特定できないため拒否します。\n')
            sys.exit(2)
        sys.exit(0)

    for file_path in file_paths:
        for pattern in DENY_PATTERNS:
            if re.search(pattern, file_path):
                message = (
                    f"[GUARD] アクセス拒否: {file_path}\n"
                    f"理由: パターン '{pattern}' に一致するファイルは変更禁止です。\n"
                    f"pubspec.yamlを変更したい場合はユーザーに確認を取ってください。"
                )
                sys.stderr.write(message + "\n")
                sys.exit(2)

    sys.exit(0)

if __name__ == '__main__':
    main()
