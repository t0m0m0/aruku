#!/bin/bash
# PostToolUse hook: Dart/Flutterの品質チェック
# ファイル編集後に自動実行される
# stderrへの出力はClaudeが自動認識して修正に活用する

set -euo pipefail

INPUT=$(cat)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel)"

if ! FILE_PATHS=$(printf '%s' "$INPUT" | python3 "$SCRIPT_DIR/guard.py" --paths); then
  echo "[dart_quality] パッチから変更対象ファイルを特定できません" >&2
  exit 0
fi

if [ -z "$FILE_PATHS" ]; then
  exit 0
fi

while IFS= read -r FILE_PATH; do
  # Dartファイル以外はスキップ
  if [[ ! "$FILE_PATH" =~ \.dart$ ]]; then
    continue
  fi

  if [[ "$FILE_PATH" = /* ]]; then
    TARGET_PATH="$FILE_PATH"
  else
    TARGET_PATH="$REPO_ROOT/$FILE_PATH"
  fi

  # 削除されたファイルはスキップ
  if [ ! -f "$TARGET_PATH" ]; then
    continue
  fi

  echo "[dart_quality] チェック開始: $FILE_PATH"

  # フォーマット
  if dart format "$TARGET_PATH" 2>&1; then
    echo "[dart_quality] format: OK"
  else
    echo "[dart_quality] format: 失敗" >&2
  fi

  # 静的解析（エラーはstderrへ）
  if ANALYZE_OUTPUT=$(dart analyze "$TARGET_PATH" 2>&1); then
    echo "[dart_quality] analyze: OK"
  else
    echo "[dart_quality] analyze エラー検出:" >&2
    echo "$ANALYZE_OUTPUT" >&2
  fi
done <<< "$FILE_PATHS"

exit 0
