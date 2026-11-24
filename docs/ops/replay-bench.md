# Transit 応答の録画・再生ハーネスの回し方（#504）

Transit API（`/guidance/plan`）の応答を URL ごとに録画し、同じ応答を録画した遅延で返して、
エンジンの2つの版を比べる。上流は中央値 9〜11 秒・裾 30 秒超とばらつく
ので、別々に実 API で回すと「版の差」と
「上流の調子」を区別できない。録画を共有すれば、差は版からしか来ない。

本体は `apps/web/src/bench/replay/`。検索の組み立てと JSONL の1行は、ブラウザのベンチ
（`bench-runner.ts`・`docs/ops/exact-ab-bench.md`）と同じものを使う。

## 何が本物で、何が模擬か

| 部分 | 扱い |
|---|---|
| Transit API | 録画の再生。録画に無い照会だけ実 API へ取りに行き（`misses`）、録画に足す |
| 徒歩プロキシ（`googleWalkProxy`・`googleWalkMatrixProxy`） | **合成応答。** 直線距離×1.25 を分速 80m で歩いた所要を、固定の遅延（単発 600ms・マトリクス 900ms）で返す（`synthetic-walk.ts`）。本物は App Check が要り、ブラウザの外から叩けないため。**徒歩の実測が効く結果（enrich で落ちる候補・徒歩分）は実際と違い得る** |
| 厳密走査（`exactWalkMax`） | 既定では使わない（404 を返す）。`--exact-packs <dir>` を渡すと、エンジンの厳密走査を有効にし、手元の時刻表パックで `findExactWalkMax` をこのプロセスで回して答える（`exact-replay.ts`・#513）。徒歩は徒歩プロキシと同じ合成の値で、応答は `--exact-delay-ms`（既定 900ms＝マトリクスの合成遅延）のあとで返す。下の「厳密走査の効果を測る」 |
| 乗車時刻の確定（`rideDepartures`） | 既定では使わない（404 を返す）。`--ride-packs <dir>` を渡すと、エンジンの `rideDepartures` を有効にし、手元の時刻表パックで `findRideDepartures` をこのプロセスで回して答える（`exact-replay.ts`・#549）。応答は `--ride-delay-ms`（既定 600ms＝単発の徒歩の合成遅延）のあとで返す。下の「乗車時刻の確定をパックで引く効果を測る」 |
| 1本の上限 | 録画時は `transitRequestTimeout`（35 秒）で打ち切る。再生時の `--refetch-limit-ms` は**ハーネス側の模擬**で、エンジンの定数は通らない。初回の2波（出発地→目的地・電車のみ）には掛けない |
| 出発日 | `--date` で固定する。照会 URL に日付が入るので、録画と同じ日を渡さないと全部外れる。エンジンの「今日」もこの日にする |

## 手順

前提: `npm --prefix apps/web ci` 済み。`apps/web/.env` は不要（ビルドは `.env` を読まない）。

1. **録画する**（実 API を直列に叩く。検索の間に 3 秒置く）

   ```sh
   cd apps/web
   node scripts/replay.mjs -- --mode record --store .replay/rec.json \
     --out .replay/record.jsonl --date 2026-11-16 --slots 12:00 --ratios 1.2,1.5,2
   ```

   - 出発日は録画する日より後の日にする（今日より前の日は検索を組めない）。平日と土休日で時刻表が違うので、比べる計測の中で曜日を揃える
   - `--pairs '^yokohama-kawasaki$'` で組（`od-pairs.ts` の `id`）を絞れる
   - 1検索で十数〜数十本を叩く。**ほかの計測と同時に回さない**（第三者 API のレート制限は非公開）

2. **比べる版を用意する**

   ```sh
   git worktree add /tmp/aruku-base origin/main
   ```

   エンジンは実行時の依存を持たないので、worktree 側で `npm ci` は要らない（束ねるのは apps/web の vite）。

3. **再生する**（上流は叩かない。並列に回してよい）

   ```sh
   node scripts/replay.mjs --engine /tmp/aruku-base/packages/engine -- \
     --store .replay/rec.json --out .replay/base.jsonl --date 2026-11-16 \
     --slots 12:00 --ratios 1.2,1.5,2 --label main
   node scripts/replay.mjs -- \
     --store .replay/rec.json --out .replay/head.jsonl --date 2026-11-16 \
     --slots 12:00 --ratios 1.2,1.5,2 --label head
   ```

   - `--engine` を省くと、この作業ツリーの `packages/engine` を使う。束ねるのはエンジンだけで、ハーネス側（`apps/web/src/bench/`）は常にこの作業ツリーのもの
   - 終わりに stderr へ `misses N` が出る。**0 でなければ、その実行は上流のばらつきを含む**（録画外れを実 API へ取りに行った）。録画は足されるので、もう一度再生すれば当たる
   - 並列に回した再生が同じ録画へ書き足しても、保存の直前に読み直して合流させるので消えない

4. **集計する**

   ```sh
   node scripts/replay-report.mjs .replay/base.jsonl .replay/head.jsonl
   ```

   組・出発時刻・倍率で突き合わせ、検索ごとの所要（`totalMs`）・guidance 本数・経路が同じかと、
   所要の中央値・平均・p90 を Markdown で出す。guidance 本数は用途別（初回照会・到着時刻照会・
   乗車時刻の確定・駅名の補完・board-search・バスの最終手段）の合計も版ごとに出す（#546）。
   エラーで計測値を持たない検索は数えない。用途別の本数を持たない古い記録が 1 件でも混ざった版は、その欄が `—` になる。経路が違う検索は両方の中身を書き出す。

## 厳密走査の効果を測る（#513）

時刻表パックが変わったこと（例: mini-tokyo-3d を足した #511）で、1検索あたりの guidance の本数と
所要がどれだけ減ったかを、同じ録画を「厳密走査なし」「パック A」「パック B」で再生して比べる。
ブラウザの A/B ベンチ（`exact-ab-bench.md`）では測れない——あちらは厳密走査なしの検索を最後まで
走らせてから候補を足すので、厳密走査が崩壊を防いで board-search を省く効果が出ない。

1. **パックを作る**（`functions/` で。ODPT のキーが要る。出力先の `.odpt/` は `.gitignore` 済み）

   ```sh
   cd functions
   ODPT_CENTER_KEY="$(gcloud secrets versions access latest --secret ODPT_CENTER_KEY --project aruku-app)" \
   ODPT_CHALLENGE_KEY="$(gcloud secrets versions access latest --secret ODPT_CHALLENGE_KEY --project aruku-app)" \
     npm run pack:local -- --out .odpt/all
   mkdir -p .odpt/odpt-only && cp -R .odpt/all/challenge .odpt/all/permanent .odpt/odpt-only/
   ```

   `.odpt/all` は ODPT と mini-tokyo-3d、`.odpt/odpt-only` は ODPT だけ。パックの運行日は作った日の
   前日〜93日先（mini-tokyo-3d）と各フィードの期間なので、`--date` はその中にする。

2. **録画する**（厳密走査なしで1回。手順の 1. と同じ）。私鉄が主役の組（`od-pairs.ts` の
   `privateRailPairs`）も回る。全部で約30組なので、`--slots 12:00 --ratios 1.5` などで絞ると1時間ほどで終わる

3. **3通りで再生する**

   ```sh
   cd apps/web
   node scripts/replay.mjs -- --store .replay/rec.json --out .replay/none.jsonl \
     --date 2026-11-20 --slots 12:00 --ratios 1.5 --label none
   node scripts/replay.mjs -- --store .replay/rec.json --out .replay/odpt.jsonl \
     --date 2026-11-20 --slots 12:00 --ratios 1.5 --label odpt \
     --exact-packs ../../functions/.odpt/odpt-only
   node scripts/replay.mjs -- --store .replay/rec.json --out .replay/all.jsonl \
     --date 2026-11-20 --slots 12:00 --ratios 1.5 --label all \
     --exact-packs ../../functions/.odpt/all
   ```

   厳密走査で勝者が変わると、録画に無い引き直しを引くので、初回の再生は `misses` が 0 にならない
   （外れは実 API へ取りに行き、録画に足す）。**3通りとも `misses 0` になるまで、出力を消して
   3通りを再生し直す。** 外れを含む実行は上流のばらつきを含み、版の差として読めない

4. **集計する**

   ```sh
   node scripts/replay-report.mjs .replay/none.jsonl .replay/odpt.jsonl
   node scripts/replay-report.mjs .replay/odpt.jsonl .replay/all.jsonl
   ```

   見るのは検索ごとの guidance 本数と `totalMs`。私鉄の組（`privateRailPairs`）だけ見たいときは、
   再生に `--pairs` でその id を渡す。

- 厳密走査の応答の遅延は固定（`--exact-delay-ms`）。本番の `exactWalkMax` の時間（`exact_walk_max` の
  ログ・`docs/ops/observability.md`）とずれていれば、そちらに合わせる
- 徒歩は合成なので、厳密走査の候補が enrich（Google の街路の実測）で落ちる分は出ない。効果は
  本番より大きめに出得る

## 乗車時刻の確定をパックで引く効果を測る（#549）

同じ録画を、`--ride-packs` なしとありで再生して比べる。厳密走査と同じパックを渡してよい。

```sh
cd apps/web
node scripts/replay.mjs -- --store .replay/rec.json --out .replay/base.jsonl \
  --date 2026-11-26 --slots 12:00 --ratios 1.5 --label base \
  --exact-packs ../../functions/.odpt/all
node scripts/replay.mjs -- --store .replay/rec.json --out .replay/ride.jsonl \
  --date 2026-11-26 --slots 12:00 --ratios 1.5 --label ride \
  --exact-packs ../../functions/.odpt/all --ride-packs ../../functions/.odpt/all
node scripts/replay-report.mjs .replay/base.jsonl .replay/ride.jsonl
```

- 見るのは用途別の「乗車時刻の確定」の本数と `totalMs`、経路が同じか。各行の `metrics.packBoardingLegs` が
  パックで確定した区間の数、`metrics.rideDepartureCalls` がエンドポイントを呼んだ回数
- 乗車区間ごとに 1 回呼ぶ（`metrics.rideDepartureCalls`）。応答の遅延は `--ride-delay-ms` で置く。本番の
  `request_latency`（`endpoint="rideDepartures"`）とずれていれば、そちらに合わせる
- パックで確定すると Transit とは別の便を採ることがあり、その先の照会が録画に無いので `misses` が立つ。
  厳密走査と同じく、`misses 0` になるまで出力を消して再生し直す
- 手元のパックが mini-tokyo-3d だけなら、JR・東京メトロ・都営などの区間は Transit に戻ったままで、
  効果は本番より小さく出る

## 引き直しの上限を模擬する（#503）

```sh
node scripts/replay.mjs -- --store .replay/rec.json --out .replay/l20000.jsonl \
  --date 2026-11-16 --refetch-limit-ms 20000 --label l20000
```

録画の遅延が上限を超える照会（初回の2波を除く）を、上限の時刻にタイムアウトさせる。各行の
`refetchLimitHits` がその検索で打ち切った本数。打ち切りで別の探索経路に入ると録画に無い照会を
引くことがあり、そのときは `misses` が立つ（上の注意と同じ）。

## 呼び出し元を記録する

`--url-log .replay/urls.jsonl` を渡すと、発行した Transit の照会ごとに URL と呼び出し元のスタックを
1行ずつ書く。どの段（実時刻の解決・best-effort・board-search）が何本引いたかを1検索の単位で見るのに使う。

## 置き場所

apps/web の下の `.replay` ディレクトリ（手順の既定の出力先）は `.gitignore` 済み。録画は第三者 API の応答そのもので数十 MB になるので、
repo に入れない。計測の結論は issue に数字で残す。
