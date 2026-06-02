#!/usr/bin/env bash
#
# Cloud Functions を us-central1 から asia-northeast1 へ移行する補助スクリプト（issue #79）。
#
# リージョンを変更すると Firebase は別の関数とみなすため、旧リージョンの関数は
# 自動削除されない。本スクリプトは「新リージョンへデプロイ → 旧 us-central1 を削除」
# を安全な順序で実行する。クライアントの PROXY_BASE_URL 切り替えは別途必要（末尾参照）。
#
# 使い方:
#   scripts/migrate-functions-region.sh              # 既定動作（確認プロンプトあり）
#   PROJECT_ID=my-proj scripts/migrate-functions-region.sh
#   scripts/migrate-functions-region.sh --skip-deploy   # 既にデプロイ済みで削除のみ
#   scripts/migrate-functions-region.sh --deploy-only   # デプロイのみ（削除しない）
#   scripts/migrate-functions-region.sh --yes           # 確認プロンプトを省略
#
set -euo pipefail

OLD_REGION="us-central1"
NEW_REGION="asia-northeast1"
FUNCTIONS=(placesProxy navitimeProxy googleWalkProxy)

# プロジェクト ID は引数 > 環境変数 > .firebaserc の default の順で決定する。
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_ID="${PROJECT_ID:-}"
if [[ -z "$PROJECT_ID" && -f "$ROOT_DIR/.firebaserc" ]]; then
  PROJECT_ID="$(node -e 'try{const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).projects.default||"")}catch(e){}' "$ROOT_DIR/.firebaserc" 2>/dev/null || true)"
fi

SKIP_DEPLOY=false
DEPLOY_ONLY=false
ASSUME_YES=false
for arg in "$@"; do
  case "$arg" in
    --skip-deploy) SKIP_DEPLOY=true ;;
    --deploy-only) DEPLOY_ONLY=true ;;
    --yes|-y) ASSUME_YES=true ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [[ -z "$PROJECT_ID" ]]; then
  echo "ERROR: PROJECT_ID を解決できません。PROJECT_ID=<id> を指定してください。" >&2
  exit 1
fi

FB="npx -y firebase-tools@latest"

echo "==> プロジェクト: $PROJECT_ID"
echo "==> 移行: $OLD_REGION -> $NEW_REGION"
echo "==> 対象関数: ${FUNCTIONS[*]}"
echo

confirm() {
  $ASSUME_YES && return 0
  read -r -p "$1 [y/N] " ans
  [[ "$ans" == "y" || "$ans" == "Y" ]]
}

# 1) 新リージョンへデプロイ（functions/src は setGlobalOptions で asia-northeast1 を指定済み）
if ! $SKIP_DEPLOY; then
  echo "==> [1/3] $NEW_REGION へデプロイ"
  (cd "$ROOT_DIR/functions" && npm run build)
  $FB deploy --only functions --project "$PROJECT_ID"
  echo
else
  echo "==> [1/3] デプロイをスキップ（--skip-deploy）"
fi

if $DEPLOY_ONLY; then
  echo "==> --deploy-only のため削除をスキップして終了。"
  echo "    クライアントの PROXY_BASE_URL を切り替えてから再度 --skip-deploy で旧関数を削除してください。"
  exit 0
fi

# 2) クライアント URL 切り替えの確認（先に旧関数を消すと配布済みアプリが 404 になる）
cat <<EOF
==> [2/3] 旧 $OLD_REGION 関数を削除する前に、以下を確認してください:
    - 本番/配布済みアプリの PROXY_BASE_URL が新リージョンを指していること
        https://$NEW_REGION-$PROJECT_ID.cloudfunctions.net
    - 新リージョン関数が稼働し、allUsers invoker 権限が付与されていること
EOF
if ! confirm "旧 $OLD_REGION 関数（${FUNCTIONS[*]}）を削除しますか？"; then
  echo "中止しました。新関数のみデプロイ済みです（旧関数は残存）。"
  exit 0
fi

# 3) 旧リージョン関数を削除
echo "==> [3/3] $OLD_REGION の関数を削除"
$FB functions:delete "${FUNCTIONS[@]}" --region "$OLD_REGION" --project "$PROJECT_ID" --force

echo
echo "==> 完了。現在の関数一覧:"
$FB functions:list --project "$PROJECT_ID" || true

cat <<EOF

==> 残作業（手動）:
    - クライアントは PROXY_BASE_URL をビルド時に注入する。本番ビルドを新 URL で作り直す:
        flutter build appbundle --release \\
          --dart-define=PROXY_BASE_URL=https://$NEW_REGION-$PROJECT_ID.cloudfunctions.net
    - 2nd gen Functions の実体は Cloud Run。残骸が無いか確認:
        gcloud run services list --region $OLD_REGION --project $PROJECT_ID
EOF
