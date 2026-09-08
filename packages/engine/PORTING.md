# Dart テスト → vitest 移植ガイド（#384 / epic #382 Phase 1）

エンジンの仕様は**テストにしか書かれていない**（CLAUDE.md「テストコードに What を書く」）。
だから Phase 1 はテストを先に運ぶ。ここはその移植で使う対応表と、意図的に揃えた／揃え
なかった点の記録。

## 位置づけ

- 移植元: `test/core/services/*_test.dart` の 6 ファイル・314 テスト
- 移植先: `packages/engine/test/services/*.test.ts`
- **この Phase ではテストは全て赤で正しい。** 本体は Phase 2（#385）で実装する。
  `src/` にあるのは型とシグネチャだけで、ロジックは `notImplemented()` を投げる。

## テスト件数の突き合わせ

完了条件は Dart 側と移植後で件数が一致すること。基準値は **314**。

```bash
npm --prefix packages/engine run count:parity
```

`flutter test --reporter=json` の `testStart` は 320 件出るが、6 件は各ファイルの
`loading …_test.dart` という擬似テストで実テストではない。**320 を目標値にしない。**

## 何を実装し、何をスタブにしたか

| 区分 | 扱い | 例 |
| --- | --- | --- |
| データ保持（コンストラクタ・フィールド・`copyWith`） | **実装する** | `RouteSegment` / `RoutePlan` / `TimeValue` |
| 2つ以上のフィールドを読む・閾値を当てる getter | スタブ | `RouteSegment.isZeroWalk` / `RouteCandidate.walkMinutes` |
| 自由関数・サービスのメソッド | スタブ | `parseGuidancePlan` / `selectBestRoute` / `TransitRouteService.plan` |

データ保持まで落とすとテストの**フィクスチャすら書けない**（`new RouteSegment({...})` が
投げる）ので、そこは実装する。線引きは「フィールドを写すだけか、ドメインの規則が入るか」。

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
| `throwsA(isA<E>())` | `expectThrowsA(action, E)`（`test/support/expect.ts`） |
| `throwsA(isA<E>().having((e) => e.f, 'f', v))` | `const e = await expectThrowsA(...); expect(e.f).toBe(v)` |
| `expectLater(future, completes)` | `await expect(p).resolves.toBeDefined()` 等（文脈ごと） |
| `fail('...')` | `expect.fail('...')` |

`closeTo` は **delta**（絶対誤差）、`toBeCloseTo` は **digits**（小数第 n 位）。機械変換
できないので、`closeTo(v, d)` は `expect(Math.abs(x - v)).toBeLessThanOrEqual(d)` へ移す。
5 箇所しかない。

## fake / stub

| Dart | TypeScript |
| --- | --- |
| `MockClient((req) async => res)` | `mockClient((url) => res)`（`test/support/mock-client.ts`） |
| `http.Response.bytes(utf8.encode(jsonEncode(b)), 200)` | `jsonResponse(b, 200)` |
| `Completer<T>()` | `deferred<T>()`（`test/support/deferred.ts`） |
| 手書き fake クラス | 手書き fake クラス（`vi.fn` へ寄せない） |

**`vi.mock` によるモジュール差し替えは使わない。** 移植元は全て**注入**で fake を渡して
おり、モジュールを差し替えると依存の向きが変わって「何が注入可能か」という設計上の情報が
テストから消える。`vi.fn` はスパイが要る箇所だけに留める。

## 型の対応

| Dart | TypeScript | 備考 |
| --- | --- | --- |
| `enum E { a, b }` | `const E = { a: 'a', b: 'b' } as const` + 同名 type | 失敗差分に `0` でなく `'a'` が出る |
| `DateTime(y, mo, d, ...)` | `dateTime(y, mo, d, ...)`（`src/time.ts`） | **JS の月は 0 始まり**。素の `new Date` を使わない |
| `Duration(seconds: n)` | `seconds(n)`（ミリ秒の `number`） | `Duration.zero` は `0` |
| `d1.difference(d2).inMinutes` | `differenceInMinutes(d1, d2)` | 切り捨て・負あり |
| 名前付き引数 | 単一のオプションオブジェクト | 呼び出し側の見た目を Dart に寄せる |
| `int?` / `double?` | `number \| null` | `undefined` に散らさず `null` へ寄せる |
| sealed class / union | discriminated union | Phase 2 で使う |

## 意図的に揃えなかった点

- **`GeoPoint` の等値**: Dart の `==` は `heading` を無視するが、`toEqual` は構造比較
  なので `heading` も見る。移植対象6ファイルは `heading` を使わないので実害は無いが、
  `heading` 付きの点を比較するテストを足すときはここが食い違う。
- **`tsconfig` の `noUncheckedIndexedAccess`**: 入れていない。理由は `tsconfig.json` の
  コメントに書いた。

## 意図的に揃えた点（変えたくなるが変えてはいけない）

- **`HttpClient` に `close()` を残す**。`fetch` + `AbortController` へ置き換えない。
  中断は「検索単位で作ったクライアントを閉じて in-flight ごと落とす」設計で、それに
  依存したテストがある（`lib/core/services/cancellation.dart` のコメント参照）。ここを
  Phase 1 で作り替えると、移植ミスと設計変更が混ざって切り分けられなくなる。
- **`Date` の naive 扱い**。Dart の非 UTC `DateTime` と JS の `Date` はどちらも
  「ローカル壁時計から作った絶対時刻」で、#121 の TZ 依存もそのまま残る。揃えている。
