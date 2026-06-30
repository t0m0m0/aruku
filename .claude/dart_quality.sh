#!/bin/bash
# PostToolUse hook: Dart/Flutterの品質チェック
# ファイル編集後に自動実行される
# stderrへの出力はClaudeが自動認識して修正に活用する

set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input', {}).get('file_path', ''))" 2>/dev/null || echo "")

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Dartファイル以外はスキップ
if [[ ! "$FILE_PATH" =~ \.(dart)$ ]]; then
  exit 0
fi

# ファイルが存在しない場合はスキップ
if [ ! -f "$FILE_PATH" ]; then
  exit 0
fi

echo "[dart_quality] チェック開始: $FILE_PATH"

# フォーマット
if dart format "$FILE_PATH" 2>&1; then
  echo "[dart_quality] format: OK"
else
  echo "[dart_quality] format: 失敗" >&2
fi

# 静的解析（エラーはstderrへ）
ANALYZE_OUTPUT=$(dart analyze "$FILE_PATH" 2>&1)
ANALYZE_EXIT=$?

if [ $ANALYZE_EXIT -ne 0 ]; then
  echo "[dart_quality] analyze エラー検出:" >&2
  echo "$ANALYZE_OUTPUT" >&2
else
  echo "[dart_quality] analyze: OK"
fi

exit 0