export function requireUsableBase(base: string, envName: string, context: string): void {
  if (isUsableBase(base)) return;
  throw new Error(
    `${context}: ${envName} がエンドポイントの前置きに使えません` +
      `（受け取った値: ${JSON.stringify(base)}）。` +
      'http(s) の絶対 URL で、クエリとフラグメントを含まないこと。' +
      'apps/web/.env.example をコピーして .env を作ってください。',
  );
}

function isUsableBase(base: string): boolean {
  if (base === '' || !URL.canParse(base)) return false;
  const { protocol } = new URL(base);
  if (protocol !== 'https:' && protocol !== 'http:') return false;

  const probePath = '/__endpoint_probe__';
  if (!URL.canParse(`${base}${probePath}`)) return false;
  const built = new URL(`${base}${probePath}`);
  return built.pathname.endsWith(probePath) && built.search === '' && built.hash === '';
}
