# Dart テスト → vitest 移植ガイド（epic #382 Phase 1〜2 / #384・#385）

エンジンの仕様は**テストにしか書かれていない**（CLAUDE.md「テストコードに What を書く」）。
だから Phase 1（#384）はテストを先に運び、Phase 2（#385）で本体を実装して全て緑にした。
ここはその移植で使う対応表と、意図的に揃えた／揃えなかった点の記録。

## 位置づけ

- 移植元: `test/core/services/*_test.dart` の 6 ファイル・314 テスト
- 移植先: `packages/engine/test/services/*.test.ts`
- #385 で7ファイルが加わった。いずれも「#384 の6ファイルを全て緑にしても一度も
  実行されない」エンジンの一部で、理由は移植先ファイルの冒頭に書いてある
  - `time_value_test.dart`（28本）→ `test/models/time-value.test.ts`
  - `frontier_stations_test.dart`（5本）→ `test/services/frontier-stations.test.ts`
  - `cancellation_test.dart`（6本）→ `test/services/cancellation.test.ts`
  - `search_deadline_test.dart`（5本）→ `test/services/search-deadline.test.ts`
  - `rail_line_names_test.dart`（4本）→ `test/services/rail-line-names.test.ts`
  - `search_scoped_route_service_test.dart`（7本）→
    `test/services/search-scoped-route-service.test.ts`
  - `app_settings_test.dart`（13本）→ `test/models/app-settings.test.ts`
- #385 でエンジン本体（`lib/core/services/` と `lib/core/models/` のうちエンジンが
  使う範囲）を `src/` へ移植し、382 本すべてが緑になった。#385 のレビュー指摘対応で
  `test/runtime/unhandled-rejection.test.ts` が加わり、現在は 383 本。

## テスト名の突き合わせ（Phase 4 で撤去）

件数だけでは足りない——「1本消して1本足す」改名が素通りし、テスト名＝仕様書という前提が
静かに崩れる（実際に1本やった・PR #389 レビュー）。だから #384〜#387 の間は
`check:port`（`tool/check-port.mjs`）が Dart のテスト名を凍結した一覧と**名前で1対1に**
照合し、CI の `engine` ジョブで回していた。

Phase 4（#387）で Dart 側を撤去する直前の最終結果は **382 対 382・全て緑・名前の差分なし**
（`test/runtime/` の1本は移植元なしで照合の対象外）。移植元が消えたので照合は撤去した。
残すと、エンジンにテストを足すたびに凍結した Dart の一覧へ書き足すことになり、
移植の網羅を見る道具が新規テストの足かせへ変わる。

Dart 側のテストは `flutter-final` タグに残っている。

## Dart ↔ TypeScript の出力突き合わせ（#385 完了条件）

移植したテストが緑なだけでは足りない——**両方の実装が同じ嘘をついている**可能性を
テストは否定しない。移植元と移植先へ同一入力を与え、出力を機械で突き合わせた。

方法: 実機構造の `/guidance/plan` 応答1本（2 transit leg・乗換徒歩・access/egress・
`routeName` が私鉄コードと和名の混在）を両側へ食わせ、6グループの出力を JSON へ書き出して
比較した。**182 個のスカラ値がすべて一致**（浮動小数は 1e-12 まで）。

| グループ | 通した関数 | 値の数 |
| --- | --- | ---: |
| parse | `parseGuidancePlan` | 69 |
| plan | `buildRoutePlan`（区間・タイムラインノード） | 86 |
| time | `arrivalMinutes` / `firstMissedTransit` / `maxBoardingWait` / `budgetMinutes` / `formatClock` | 7 |
| select | `selectBestRoute` / `measureShortlist` | 6 |
| geo | `haversineKm` / `evenSample` / `frontierStations` / `walkFeasiblePrefixCount` | 9 |
| format | `stripStationRomaji` / `transitSecsToJst` / 座標の文字列化 / `TimeValue` の整形 | 5 |

移植で最も壊れやすい箇所が一致していることを確認できた:

- `transitSecsToJst('20260627', 90000)` → `2026-06-28 01:00:00.000`（86400 超の翌日繰り上がり）
- 座標のワイヤーフォーマット → `35.0,139.0`（`String(35)` なら `35` になる箇所）
- `arrivalMinutes` が待ち込み 78 分・待ち抜き 70 分（`_advance` の乗車待ち吸収）
- `haversineKm` が `45.54279110090217`（倍精度の下位桁まで）
- 路線名 `IN` → `京王井の頭線`、駅名 `東京 Tokyo` → `東京`

**突き合わせ用のハーネスは残していない。** Dart 側は `flutter test` からしか起動できず
（`dart run` は `dart:ui` を解決できない）、何より Phase 4 で Dart 側が消えるので、
置けば確実に腐る。再現したいときは
この節の入力と関数の一覧から組み直すこと。

## `group` / `test` → `describe` / `it`

```dart
group('plan: 入力ガード', () {
  test('origin が無ければ NO_ORIGIN', () async { ... });
});
```

```ts
describe('plan: 入力ガード', () => {
  it('origin が無ければ NO_ORIGIN', async () => { ... });
});
```

**テスト名は一字一句そのまま運ぶ。** 名前が仕様書なので、訳したり整えたりしない。

## matcher 対応表

`expect(actual, matcher)` → `expect(actual).toXxx()`。

| Dart (`package:matcher`) | vitest |
| --- | --- |
| `expect(x, y)`（素の値＝`equals`） | `expect(x).toEqual(y)` |
| `expect(x, same(y))` | `expect(x).toBe(y)`（同一性） |
| `isTrue` / `isFalse` | `.toBe(true)` / `.toBe(false)` |
| `isNull` / `isNotNull` | `.toBeNull()` / `.not.toBeNull()` |
| `isEmpty` / `isNotEmpty` | `.toHaveLength(0)` / `.not.toHaveLength(0)` |
| `hasLength(n)` | `.toHaveLength(n)` |
| `contains(x)`（String / Iterable 共通） | `.toContain(x)` |
| `startsWith(s)` | `expect(x.startsWith(s)).toBe(true)` |
| `greaterThan(n)` / `greaterThanOrEqualTo(n)` | `.toBeGreaterThan(n)` / `.toBeGreaterThanOrEqual(n)` |
| `lessThan(n)` / `lessThanOrEqualTo(n)` | `.toBeLessThan(n)` / `.toBeLessThanOrEqual(n)` |
| `closeTo(v, delta)` | `.toBeCloseTo(v, digits)`（**引数の意味が違う**・下記） |
| `allOf(a, b)` | 2 つの `expect` に分ける |
| `expect(x, y, reason: 'なぜ')` | `expect(x, 'なぜ').toEqual(y)` |
| `expect(list, [a, b, c])`（要素が `==` 未定義のクラス） | `expectSameList(list, [a, b, c])`（同一性・下記） |
| `throwsA(isA<E>())` | `expectThrowsA(action, E)`（`packages/engine/test/support/expect.ts`） |
| `throwsA(isA<E>().having((e) => e.f, 'f', v))` | `const e = await expectThrowsA(...); expect(e.f).toBe(v)` |
| `expectLater(future, completes)` | `await expect(p).resolves.toBeDefined()` 等（文脈ごと） |
| `fail('...')` | `expect.fail('...')` |
| `future.timeout(d, onTimeout: () => fail(m))` | `withTimeout(promise, ms, () => expect.fail(m))` |
| `list.single` / `.first` / `.last` / `firstWhere` / `singleWhere` | 同名の helper（`packages/engine/test/support/iterable.ts`） |
| `Foo()..a = 1..b = 2`（カスケード） | `cascade(new Foo(), (f) => { f.a = 1; f.b = 2; })` |

Dart の `equals` はリストの要素を `==` で比べる。`RouteCandidate` のように `==` を
定義していないクラスではそれが**同一性**の比較になるので、`toEqual`（構造比較）へ落とすと
「構造は同じだが別インスタンス」を返す実装を通してしまう。候補プールの同一性に依存する
検証（#318 の先行実測対象）が骨抜きになるため `expectSameList` を使う。`GeoPoint` は
`==` を値で定義しているので `toEqual` のままでよい。

`closeTo` は **delta**（絶対誤差）、`toBeCloseTo` は **digits**（小数第 n 位）。機械変換
できないので、`closeTo(v, d)` は `expect(Math.abs(x - v)).toBeLessThanOrEqual(d)` へ移す。
5 箇所しかない。

## fake / stub

| Dart | TypeScript |
| --- | --- |
| `MockClient((req) async => res)` | `mockClient((url) => res)`（`packages/engine/test/support/mock-client.ts`） |
| `http.Response.bytes(utf8.encode(jsonEncode(b)), 200)` | `jsonResponse(b, 200)` |
| `Completer<T>()` | `deferred<T>()`（`packages/engine/test/support/deferred.ts`） |
| 手書き fake クラス | 手書き fake クラス（`vi.fn` へ寄せない） |
| `'${p.lat},${p.lng}'`（座標の文字列化） | `dartDouble(p.lat)`（`packages/engine/test/support/dart-number.ts`・下記） |

**`vi.mock` によるモジュール差し替えは使わない。** 移植元は全て**注入**で fake を渡して
おり、モジュールを差し替えると依存の向きが変わって「何が注入可能か」という設計上の情報が
テストから消える。`vi.fn` はスパイが要る箇所だけに留める。

## 型の対応

| Dart | TypeScript | 備考 |
| --- | --- | --- |
| `enum E { a, b }` | `const E = { a: 'a', b: 'b' } as const` + 同名 type | 失敗差分に `0` でなく `'a'` が出る |
| `DateTime(y, mo, d, ...)` | `dateTime(y, mo, d, ...)`（`packages/engine/src/time.ts`） | **JS の月は 0 始まり**。素の `new Date` を使わない |
| `Duration(seconds: n)` | `seconds(n)`（ミリ秒の `number`） | `Duration.zero` は `0` |
| `d1.difference(d2).inMinutes` | `differenceInMinutes(d1, d2)` | 切り捨て・負あり |
| 名前付き引数 | 単一のオプションオブジェクト | 呼び出し側の見た目を Dart に寄せる |
| `int?` / `double?` | `number \| null` | `undefined` に散らさず `null` へ寄せる |
| sealed class / union | discriminated union | |

## 意図的に揃えなかった点

- **`GeoPoint` の等値**: Dart の `==` は `heading` を無視するが、`toEqual` は構造比較
  なので `heading` も見る。移植対象6ファイルは `heading` を使わないので実害は無いが、
  `heading` 付きの点を比較するテストを足すときはここが食い違う。
- **`tsconfig` の `noUncheckedIndexedAccess`**: 入れていない。理由は `packages/engine/tsconfig.json` の
  コメントに書いた。

## 意図的に揃えた点（変えたくなるが変えてはいけない）

- **`HttpClient` に `close()` を残す**。`fetch` + `AbortController` へ置き換えない。
  中断は「検索単位で作ったクライアントを閉じて in-flight ごと落とす」設計で、それに
  依存したテストがある（`flutter-final:lib/core/services/cancellation.dart` のコメント参照）。ここを
  Phase 1 で作り替えると、移植ミスと設計変更が混ざって切り分けられなくなる。
- **座標の文字列化**。Dart の `double.toString()` は整数値でも `35.0` と小数点を出すが、
  JavaScript の `String(35.0)` は `35` になる。上流へ送る `geo:35.0,139.0` /
  `origins=35.0,139.0` は**ワイヤーフォーマット**なので、期待値は Dart のまま運んだ。
  書式を再現するのは `src/dart-number.ts` の `dartDouble`。`String(n)` で済ませると
  送信内容が変わる。
- **`Date` の naive 扱い**。Dart の非 UTC `DateTime` と JS の `Date` はどちらも
  「ローカル壁時計から作った絶対時刻」で、#121 の TZ 依存もそのまま残る。揃えている。
