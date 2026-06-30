#!/usr/bin/env python3
"""
PreToolUse hook: 危険なbashコマンドのガード
"""

import json
import sys
import re

DENY_PATTERNS = [
    (r'rm\s+-rf\s+/', '/ 以下の強制削除は禁止です'),
    (r'git\s+push\s+.*--force', 'force pushは禁止です'),
    (r'git\s+checkout\s+main\s*$', 'mainブランチへの直接チェックアウトの前に確認が必要です'),
    (r'git\s+merge\s+main', 'mainブランチへの直接マージは禁止です（PRを使うこと）'),
    (r'flutter\s+clean\s*&&\s*rm', 'flutter clean後の連鎖削除は禁止です'),
    (r'curl\s+.*\|\s*(bash|sh)', 'curlの出力を直接シェルに渡すことは禁止です'),
    (r'>\s*/dev/null\s+2>&1\s*;\s*rm', '標準出力を捨てながらの削除は禁止です'),
]

def main():
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)

    command = input_data.get('tool_input', {}).get('command', '')
    if not command:
        sys.exit(0)

    for pattern, reason in DENY_PATTERNS:
        if re.search(pattern, command):
            message = (
                f"[GUARD] コマンド拒否\n"
                f"コマンド: {command[:100]}\n"
                f"理由: {reason}"
            )
            sys.stderr.write(message + "\n")
            sys.exit(2)

    sys.exit(0)

if __name__ == '__main__':
    main()