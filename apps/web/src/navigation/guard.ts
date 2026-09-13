// 移植元: lib/core/navigation/app_router.dart の `redirect`。

import { isNowRouteExpired, type RouteCore } from '../state/app-state';
import {
  fallbackScreen,
  Screen,
  screenFromLocation,
  screenPath,
} from './screens';

/// この location を表示してよいか判定し、跳ね返す先を返す（表示してよければ null）。
///
/// 純粋関数にするのは、移植元が `isNowRouteExpired` をそうしていたのと同じ理由——
/// deep link・ブラウザ履歴・アプリ内遷移はすべてここを通るので、判定を一箇所に集約
/// すると全経路で一貫する。描画も router も無しで反証できる形にしておく。
export function resolveRedirect(
  location: string,
  state: RouteCore,
  now: Date,
): string | null {
  const requestedPath = new URL(location, 'https://placeholder.invalid').pathname;
  const target = screenFromLocation(requestedPath);

  // 未登録の location（削除済みのパスやタイプミスの deep link）は
  // screenFromLocation が安全側の home へ解決する。その正規パスへ明示的に跳ね返して、
  // 未知 location の戻り先を home に集約する（#312）。
  if (screenPath[target] !== requestedPath) return screenPath[target];

  // 失効した isNow 経路（#264）は「表示前提データ欠落」と同じく home へ跳ね返す。
  const expired = isNowRouteExpired(state, now);
  // `=== null` ではなく `== null` で undefined も欠落として扱う。RouteCore の
  // フィールドは `X | null` だが、go() が受ける Partial<RouteCore> には
  // `{ route: undefined }` を渡せてしまう。型で防ぐには exactOptionalPropertyTypes が
  // 要り、それは packages/engine のソースにも掛かる（engine 側の tsconfig は入れて
  // いない）。ここは描画の可否を決める最後の関門なので、値の側で受け止める。
  const missingPrerequisite =
    (target === Screen.result && (state.route == null || expired)) ||
    (target === Screen.loading && state.routePhase == null) ||
    (target === Screen.error && state.routeErrorKind == null);

  return missingPrerequisite ? screenPath[fallbackScreen] : null;
}
