#!/usr/bin/env python3
"""
PreToolUse hook: 危険なbashコマンドのガード
"""

import json
import re
import shlex
import subprocess
import sys

DENY_PATTERNS = [
    (r'rm\s+-rf\s+/', '/ 以下の強制削除は禁止です'),
    (r'git\s+checkout\s+main\s*$', 'mainブランチへの直接チェックアウトの前に確認が必要です'),
    (r'git\s+merge\s+main', 'mainブランチへの直接マージは禁止です（PRを使うこと）'),
    (r'curl\s+.*\|\s*(bash|sh)', 'curlの出力を直接シェルに渡すことは禁止です'),
    (r'>\s*/dev/null\s+2>&1\s*;\s*rm', '標準出力を捨てながらの削除は禁止です'),
]

# Read/Edit 側は settings.json の permissions.deny が止める。シェル経由の `cat .env` は
# そこを素通りするので、コマンド文字列からも拾う。雛形（.env.example）は秘密を含まない。
ENV_FILE_RE = re.compile(r'(?<![\w.-])\.env(?:\.([\w-]+))?(?![\w-])')
ENV_TEMPLATE_SUFFIXES = {'example', 'sample', 'template'}

PROTECTED_BRANCH = 'main'
SHELL_OPERATORS = {'&&', '||', ';', '|', '&', '\n', '(', ')'}


def current_branch(cwd):
    try:
        result = subprocess.run(
            ['git', 'symbolic-ref', '--short', '-q', 'HEAD'],
            cwd=cwd, capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    branch = result.stdout.strip()
    return branch or None


def split_simple_commands(command):
    # 文字列を `;` などで素朴に割ると、コミットメッセージ内の `;` で切れてしまう。
    lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    try:
        tokens = list(lexer)
    except ValueError:
        tokens = command.split()
    commands, current = [], []
    for token in tokens:
        if token in SHELL_OPERATORS or set(token) <= set('&|;()'):
            if current:
                commands.append(current)
            current = []
        else:
            current.append(token)
    if current:
        commands.append(current)
    return commands


def git_subcommand(tokens):
    """`git [-C dir] <sub> args...` を (sub, args) にする。git でなければ None。"""
    if not tokens or tokens[0] != 'git':
        return None
    rest = tokens[1:]
    while rest and rest[0].startswith('-'):
        takes_value = rest[0] in ('-C', '-c')
        rest = rest[2:] if takes_value else rest[1:]
    if not rest:
        return None
    return rest[0], rest[1:]


def push_deny_reason(args, branch):
    positional = []
    for arg in args:
        if arg.startswith('--force') or arg == '--mirror':
            return 'force pushは禁止です'
        if re.fullmatch(r'-[a-zA-Z]+', arg) and 'f' in arg[1:]:
            return 'force pushは禁止です'
        if not arg.startswith('-'):
            positional.append(arg)
    refspecs = positional[1:]
    for refspec in refspecs:
        if refspec.startswith('+'):
            return 'force pushは禁止です（+refspec）'
        destination = refspec.split(':')[-1]
        if destination in (PROTECTED_BRANCH, f'refs/heads/{PROTECTED_BRANCH}'):
            return 'mainへの直接pushは禁止です（PRを使うこと）'
    if not refspecs and branch == PROTECTED_BRANCH:
        return 'main上からのpushは禁止です（ブランチを切ってPRを使うこと）'
    return None


def mentions_env_file(tokens):
    return any(
        match.group(1) not in ENV_TEMPLATE_SUFFIXES
        for token in tokens
        for match in ENV_FILE_RE.finditer(token)
    )


def carries_free_text(tokens, parsed):
    # コミットメッセージや issue 本文は散文で、`.env` という語が出てもファイルには触れない。
    if tokens and tokens[0] == 'gh':
        return True
    return parsed is not None and parsed[0] == 'commit'


def deny_reason(command, branch):
    for pattern, reason in DENY_PATTERNS:
        if re.search(pattern, command):
            return reason

    for tokens in split_simple_commands(command):
        parsed = git_subcommand(tokens)
        if not carries_free_text(tokens, parsed) and mentions_env_file(tokens):
            return '.env（秘密情報）へのアクセスは禁止です'
        if parsed is None:
            continue
        sub, args = parsed
        if sub == 'commit' and branch == PROTECTED_BRANCH:
            return 'mainへの直接コミットは禁止です（ブランチを切ること）'
        if sub == 'push':
            reason = push_deny_reason(args, branch)
            if reason:
                return reason
    return None


def main():
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)

    command = input_data.get('tool_input', {}).get('command', '')
    if not command:
        sys.exit(0)

    reason = deny_reason(command, current_branch(input_data.get('cwd') or '.'))
    if reason:
        sys.stderr.write(
            f"[GUARD] コマンド拒否\n"
            f"コマンド: {command[:100]}\n"
            f"理由: {reason}\n"
        )
        sys.exit(2)

    sys.exit(0)


if __name__ == '__main__':
    main()
