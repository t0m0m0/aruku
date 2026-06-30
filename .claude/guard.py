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

def main():
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)

    file_path = input_data.get('tool_input', {}).get('file_path', '')
    if not file_path:
        sys.exit(0)

    # 相対パスに正規化
    file_path = os.path.normpath(file_path)

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