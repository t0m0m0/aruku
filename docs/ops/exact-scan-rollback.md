# 厳密走査の切り戻し（#477）

本番の厳密走査（`exactWalkMax`）を止める手順。Web のビルド時の
フラグ `VITE_EXACT_WALK_MAX=1` で有効にしているので、止めるのは Web の配信であって Functions ではない。

乗車時刻の確定に時刻表パックを使うこと（`rideDepartures`・#551）も、同じく Web のビルド時のフラグ
`VITE_RIDE_DEPARTURES=1` で有効にしている。止め方は同じで、下の手順の `VITE_EXACT_WALK_MAX` を
`VITE_RIDE_DEPARTURES` に、テスト名を `本番では乗車時刻の確定に時刻表パックを使う (#551)` に、ログの
確かめ方を `request_latency` の `endpoint="rideDepartures"` に読み替える。`rideDepartures` の失敗は
その区間を Transit で確定し直すだけなので、検索は壊れない。止めるのは、実在しない便を案内している
ときと、ライセンスの条件で公開を止める必要があるとき。

## いつ切り戻すか

厳密走査の失敗は検索を壊さない（空の候補として続行する）。503・タイムアウトが出ているだけなら、
経路は厳密走査なしの結果に戻っているので急がなくてよい。切り戻すのは次のとき。

- 時刻表の誤りで、実在しない便や乗れない便を案内している
- `ComputeRouteMatrix` の1日の上限を厳密走査が食い、`googleWalkMatrixProxy` まで失敗している。
  厳密走査は1検索で最大24組を使い、上限（3,000組）は同じプロジェクトの呼び出しで共用する
- ライセンスの条件で公開を止める必要がある

## すぐ止める: Cloudflare Pages で前の配信へ戻す

CI を待たずに戻せる。

1. Cloudflare の dashboard で Workers & Pages → `aruku` → Deployments を開く
2. 厳密走査を有効にする前の本番配信を選び、Rollback to this deployment を実行する

配信物をまるごと戻すので、その配信より後の変更も一緒に消える。main は変わらないので、次に
`deploy-web.yml` が走ると厳密走査は戻る。**次の配信の前に、下の手順で main を直す。**

## 恒久に止める: main からフラグを外す

有効にしたコミットを `git revert` して PR を通す。main へ入ると `deploy-web.yml` が再配信する。

手で消すときは、次の3か所を同じコミットで直す。`deploy-workflow.test.ts` は build ジョブでも走るので、
`.github/workflows/deploy-web.yml` の `env` だけを消すとテストで落ち、配信されない。

- `.github/workflows/deploy-web.yml` の `env` の `VITE_EXACT_WALK_MAX`
- 同じファイルの「Verify required configuration」のリスト
- `apps/web/test/build/deploy-workflow.test.ts` の `本番では厳密走査を有効にする (#477)`

README の「本番は有効」という記述も同じコミットで直す。

## 止まったことの確かめ方

Cloud Logging で `exactWalkMax` への要求が来なくなることを見る。

```bash
gcloud logging read 'jsonPayload.event="exact_walk_max"' --project aruku-app --freshness=1h --limit 5
```

ブラウザが古いバンドルを持っている間は要求が残るので、検索を1回して Network に `exactWalkMax` が
出ないことも見る。結果画面の「時刻表データについて」も出なくなる。

Functions の `exactWalkMax` と `refreshTimetablePacks` は止めなくてよい。フラグが切れていれば Web は
`exactWalkMax` を呼ばない。チャレンジ限定データの削除は別の手順で行う（#463）。
