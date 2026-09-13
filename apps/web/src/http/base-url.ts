/// ベース URL が、エンドポイントのパスを前置きできる形であることを組み立て時に確かめる。
///
/// 空のまま渡すとエンジンが `new URL('/googleWalkMatrixProxy')` を評価する瞬間に
/// TypeError で倒れる。移植元は `Uri.parse` が相対 URI を作れたので同じ穴が無い。
///
/// 「絶対 URL か」だけでは足りない。呼ぶ側は base とパスを**文字列連結**してから
/// `new URL` するため（transit-api-client.ts の `buildUri`）、連結してなお意図した
/// 経路になる形だけを通す必要がある。`https://proxy.example?tenant=a` は絶対 URL だが、
/// 連結すると `?tenant=a/googleWalkProxy` というクエリになりパスは `/` のまま——
/// プロキシに届かないのに素通りする。`mailto:` も同様で、fetch まで行って初めて失敗する。
///
/// パスの前置き（`https://example.com/api`）は通す。リライト運用で実際に使う形のため。
///
/// RouteException / PlacesException にしないのはエンジンの先例に倣う——配線漏れを
/// それらにすると縮退パス（候補ドロップ・直線推定・「候補なし」表示）に握り潰され、
/// 設定漏れが「徒歩が長い経路」や「何も出ない検索」として静かに出てしまう
/// （transit-api-client.ts の 'no HTTP client was injected'）。環境変数名を載せるのは、
/// バンドル後のスタックからは出どころが読めないため。
export function requireUsableBase(
  base: string,
  envName: string,
  context: string,
): void {
  if (isUsableBase(base)) return;
  throw new Error(
    `${context}: ${envName} がエンドポイントの前置きに使えません` +
      `（受け取った値: ${JSON.stringify(base)}）。` +
      'http(s) の絶対 URL で、クエリとフラグメントを含まないこと。' +
      'apps/web/.env.example をコピーして .env を作ってください。',
  );
}

/// 呼ぶ側と同じ文字列連結を実際に試して確かめる。
///
/// 個別の性質（クエリの有無など）を URL API に尋ねるだけでは足りない。素の区切り文字
/// だけが末尾に付いた `https://proxy.example/api?` は `search` も `hash` も空文字で返り、
/// 検査を素通りするのに、連結すると `?/googleWalkProxy` というクエリになってパスは
/// `/api` のまま。末尾の空白は逆に、単体ではパースできるのに連結した URL が例外になる。
/// 壊れ方が連結後にしか現れない以上、連結して確かめるのが唯一の確実な検査。
function isUsableBase(base: string): boolean {
  if (base === '' || !URL.canParse(base)) return false;
  const { protocol } = new URL(base);
  if (protocol !== 'https:' && protocol !== 'http:') return false;

  const probePath = '/__endpoint_probe__';
  if (!URL.canParse(`${base}${probePath}`)) return false;
  const built = new URL(`${base}${probePath}`);
  return (
    built.pathname.endsWith(probePath) &&
    built.search === '' &&
    built.hash === ''
  );
}
