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
SEPARATOR_CHARS = set('&|;()\n')


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
    # shlex は既定で改行を空白として読み捨てるため、引用符の外の改行を区切りとして
    # 残すよう whitespace から外し、句読点として扱わせる。
    lexer = shlex.shlex(command, posix=True, punctuation_chars='();<>|&\n')
    lexer.whitespace = ' \t\r'
    lexer.whitespace_split = True
    try:
        tokens = list(lexer)
    except ValueError:
        tokens = command.split()
    commands, current = [], []
    for token in tokens:
        if set(token) <= SEPARATOR_CHARS:
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


# コミットメッセージや issue 本文は散文で、`.env` という語が出てもファイルには触れない。
# ただし `-F <file>`・`--body-file`・`key=@file` はファイルを読み込んで送るので免除しない。
COMMIT_LITERAL_FLAGS = ('-m', '--message')
GH_LITERAL_FLAGS = ('-f', '--raw-field', '-b', '--body', '-t', '--title')
GH_FIELD_FLAGS = ('-F', '--field')


def literal_value_positions(tokens, flags, accepts):
    positions = set()
    for index, token in enumerate(tokens):
        for flag in flags:
            if token == flag and index + 1 < len(tokens) and accepts(tokens[index + 1]):
                positions.add(index + 1)
            elif token.startswith(flag + '=') and accepts(token[len(flag) + 1:]):
                positions.add(index)
            elif len(flag) == 2 and token.startswith(flag) and len(token) > 2 \
                    and not token.startswith('--') and accepts(token[2:]):
                positions.add(index)
    return positions


def literal_text_positions(tokens, parsed):
    if parsed is not None and parsed[0] == 'commit':
        return literal_value_positions(tokens, COMMIT_LITERAL_FLAGS, lambda _: True)
    if tokens and tokens[0] == 'gh':
        literal = literal_value_positions(tokens, GH_LITERAL_FLAGS, lambda _: True)
        fields = literal_value_positions(
            tokens, GH_FIELD_FLAGS, lambda value: '=@' not in value)
        return literal | fields
    return set()


def mentions_env_file(tokens, skipped):
    return any(
        match.group(1) not in ENV_TEMPLATE_SUFFIXES
        for index, token in enumerate(tokens)
        if index not in skipped
        for match in ENV_FILE_RE.finditer(token)
    )


def deny_reason(command, branch):
    for pattern, reason in DENY_PATTERNS:
        if re.search(pattern, command):
            return reason

    for tokens in split_simple_commands(command):
        parsed = git_subcommand(tokens)
        if mentions_env_file(tokens, literal_text_positions(tokens, parsed)):
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
