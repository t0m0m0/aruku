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
  使う範囲）を `src/` へ移植し、382 本すべてが緑になった。

## テスト名の突き合わせ

完了条件は Dart 側と移植後で件数が一致すること。基準値は #384 時点で **314**（#385 で
加えた7ファイルを含めて 382）。ただし件数だけでは足りない——「1本消して1本足す」改名が素通りし、テスト名＝仕様書という前提が静かに
崩れる（実際に1本やった・PR #389 レビュー）。だから **名前で1対1に照合する**。

```bash
npm --prefix packages/engine run check:port
```

照合の基準は `packages/engine/tool/dart-test-names.json` に固定してある（engine の CI は
Flutter を持たないため、Dart 側を都度実行できない）。Dart のテスト名を変えたらここも
同じコミットで取り直すこと:

```bash
flutter test test/core/services/{transit_route_service,hybrid_route_selector,route_plan_builder,\
transit_plan_parser,transit_api_client,route_diagnostics}_test.dart --reporter=json \
  | python3 -c "
import sys, json, os, collections
suites, out = {}, collections.defaultdict(list)
for line in sys.stdin:
    try: e = json.loads(line)
    except ValueError: continue
    if e.get('type') == 'suite':
        suites[e['suite']['id']] = os.path.basename(e['suite']['path'])
    elif e.get('type') == 'testStart':
        t = e['test']
        if t['name'].startswith('loading '): continue
        out[suites[t['suiteID']]].append(t['name'])
json.dump({k: out[k] for k in sorted(out)},
          open('packages/engine/tool/dart-test-names.json', 'w'),
          ensure_ascii=False, indent=2)
"
```

`flutter test --reporter=json` の `testStart` は 320 件出るが、6 件は各ファイルの
`loading …_test.dart` という擬似テストで実テストではない。**320 を目標値にしない。**

## CI での扱い

`packages/engine` は CI（`.github/workflows/ci.yml` の `engine` ジョブ）で
`tsc --noEmit`・`vitest run`・`check:port` を回す。

3つとも要る。`vitest run` は「落ちているテストがあるか」だけを答え、**移植されていない
テストがあるか**には答えない——移植漏れは vitest から見れば存在しないファイルでしかなく、
静かに緑になる。`check:port` はそこだけを見る（Dart 側と名前で1対1か・`it.skip` で実行を
止めていないか）。逆に `check:port` は失敗理由を見ないので、素の `vitest run` を繋がないと
赤いテストが素通りする。

#384 の間は `vitest run` を繋がず、代わりに `check:port` が**期待する赤の内訳**（落ちる
理由がすべて未実装か・緑になってよいのは既定値だけを主張する6本か）を検査していた。あの
Phase の完了条件が「全て赤」だったためで、素直に繋ぐと #385 が終わるまで CI が永久に赤く
なり他 PR のシグナルが死ぬ。#385 で全て緑になったのでその検査は撤去し、素の `vitest run`
へ戻した。

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
  依存したテストがある（`lib/core/services/cancellation.dart` のコメント参照）。ここを
  Phase 1 で作り替えると、移植ミスと設計変更が混ざって切り分けられなくなる。
- **座標の文字列化**。Dart の `double.toString()` は整数値でも `35.0` と小数点を出すが、
  JavaScript の `String(35.0)` は `35` になる。上流へ送る `geo:35.0,139.0` /
  `origins=35.0,139.0` は**ワイヤーフォーマット**なので、期待値は Dart のまま運んだ。
  書式を再現するのは `src/dart-number.ts` の `dartDouble`。`String(n)` で済ませると
  送信内容が変わる。
- **`Date` の naive 扱い**。Dart の非 UTC `DateTime` と JS の `Date` はどちらも
  「ローカル壁時計から作った絶対時刻」で、#121 の TZ 依存もそのまま残る。揃えている。
