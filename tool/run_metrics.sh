#!/usr/bin/env bash
# 実機で aruku の [route-metrics] ログ（#309）を採取して集計する（#310 判断材料）。
#
# なぜ profile か: metricsEnabled(!kReleaseMode) で [route-metrics] は出るが、verbose(kDebugMode)
# は無効なので定性ログ [route] のスパムが無く、レイテンシも実機相当（debug は遅く歪む）。
#
# 2モード:
#   (既定)       flutter run --profile … ビルド+インストール+ログ配信。USB 接続で最も確実。
#   --logs-only  flutter logs … デバイス syslog を直接ストリーム。Dart VM Service の接続が
#                要らないので **無線接続でも拾える**。アプリは事前に手動起動しておく。
#
# 使い方:
#   tool/run_metrics.sh                  # iOS 実機へ profile 起動（USB 推奨）
#   tool/run_metrics.sh --logs-only      # 既にインストール済みの実機ログだけ採る（無線可）
#   tool/run_metrics.sh [--logs-only] <device-id>
# → アプリで検索を数回実行 → コンソールで q（run）/ Ctrl-C（logs）で終了 → 集計が自動で走る。
set -euo pipefail

export PATH="$HOME/development/flutter/bin:$PATH"
cd "$(dirname "$0")/.."

LOGS_ONLY=0
if [ "${1:-}" = "--logs-only" ]; then
  LOGS_ONLY=1
  shift
fi

DEVICE="${1:-}"
if [ -z "$DEVICE" ]; then
  # 最初の iOS 実機（エミュレータ以外）を --machine JSON から拾う。
  DEVICE=$(flutter devices --machine 2>/dev/null | python3 -c '
import sys, json
ds = json.load(sys.stdin)
print(next((d["id"] for d in ds
            if str(d.get("targetPlatform", "")).startswith("ios")
            and not d.get("emulator", False)), ""))')
fi
if [ -z "$DEVICE" ]; then
  echo "iOS 実機が見つかりません。flutter devices で接続を確認してください。" >&2
  exit 1
fi

mkdir -p build
LOG="build/route-metrics-$(date +%Y%m%d-%H%M%S).log"
echo "▶ device=$DEVICE / ログ: $LOG"

# 実機での検索は人手が要る（対話的）。終了後に採取ログを集計する。
set +e
if [ "$LOGS_ONLY" -eq 1 ]; then
  echo "▶ syslog をストリームします。ホーム画面からアプリを起動→検索を数回→Ctrl-C で終了。"
  flutter logs -d "$DEVICE" 2>&1 | tee "$LOG"
else
  echo "▶ profile 起動します（USB 推奨）。検索を数回試したら、コンソールで q を押して終了。"
  echo "  無線で 'Dart VM Service was not discovered' が出て止まる場合は、USB 接続か、"
  echo "  端末で『ローカルネットワーク』許可を有効化。手っ取り早くは --logs-only モードを使う。"
  flutter run --profile -d "$DEVICE" --dart-define=USE_REAL_MAP=true 2>&1 | tee "$LOG"
fi
set -e

echo
echo "=== route-metrics 集計 ==="
dart run tool/route_metrics_agg.dart "$LOG"
