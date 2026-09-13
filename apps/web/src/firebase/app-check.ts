// 移植元: lib/main.dart の `_activateAppCheck` と lib/core/config/app_check_provider.dart。
//
// 判定だけを純関数に切り出してあるのは移植元と同じ形。Firebase に触れる部分は薄く
// 保ち、「いつバイパスを許すか」という security の芯をテストで押さえる。

import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  CustomProvider,
  getLimitedUseToken,
  getToken,
  initializeAppCheck,
  ReCaptchaV3Provider,
  type AppCheck,
  type AppCheckOptions,
} from 'firebase/app-check';

import { appConfig } from '../config';
import type { AppCheckProviders } from '../search/route-service';

/// App Check を有効化できるか。
///
/// 有効化しない選択肢を残すのは移植元と同じ理由——プロバイダを構築できないまま
/// 初期化すると起動ごと倒れる。有効化を見送った場合プロキシは 401 を返す（＝安全側）。
///
/// デバッグ時にサイトキーが不要なのは、SDK がデバッグモードではプロバイダを
/// 一切呼ばずにトークン交換するため（getToken / getLimitedUseToken の両方で確認）。
export function canActivateAppCheck(options: {
  usesDebugProvider: boolean;
  recaptchaSiteKey: string;
}): boolean {
  return options.usesDebugProvider || options.recaptchaSiteKey.trim() !== '';
}

/// トークンを取れない状態を表すプロバイダ。
///
/// App Check を有効化できなかったときの成り行き。ヘッダが付かず、プロキシは
/// 「トークン欠落」で 401 を返す。握り潰して素通しにはしない——課金 API が
/// 素通しで開くほうが、検索が失敗するよりはるかに悪い。
const unavailableProviders: AppCheckProviders = {
  tokenProvider: () => Promise.resolve(null),
  limitedUseTokenProvider: () => Promise.resolve(null),
};

let appCheck: AppCheck | null = null;
let firebaseApp: FirebaseApp | null = null;

/// Firebase を初期化し、App Check のトークン取得口を返す。
///
/// 起動で1回だけ呼ぶ。移植元は `FirebaseAppCheck.instance` という静的な入口を
/// 持っていたが、JS SDK の getToken は initializeAppCheck が返すインスタンスを要る
/// ——だから合成のルートまで持ち上がる（app-check-http-client.ts の注記）。
export function initializeFirebaseAppCheck(): AppCheckProviders {
  if (appCheck !== null) return providersFor(appCheck);

  const { recaptchaSiteKey } = appConfig;

  if (
    !canActivateAppCheck({
      usesDebugProvider: import.meta.env.DEV,
      recaptchaSiteKey,
    })
  ) {
    return unavailableProviders;
  }

  firebaseApp ??= initializeApp(appConfig.firebase);

  // `import.meta.env.DEV` を**直に**書く。移植元の「配布物にはバイパスが入り得ない」
  // という構造的な保証（#297）を、Vite では定数畳み込みで作る——本番ビルドでは
  // `if (false)` になり、分岐ごとバンドルから消える。
  //
  // 引数や変数を1つでも経由させてはいけない。`isDev` を既定引数にしていたときは
  // 畳めず、デバッグトークンを書き込む行が本番バンドルに残っていた（dist を
  // grep して確認）。実行時に到達しないだけの「安全」は、移植元が避けた形そのもの。
  //
  // トークン**そのもの**もこの中で読む。`appConfig` のプロパティにすると、分岐が
  // 消えても値だけが平文で残る——生きた export のプロパティは落ちないため
  // （config.ts の注記。実トークンで本番ビルドして確認済み）。
  if (import.meta.env.DEV) {
    const debugToken = (import.meta.env.VITE_APP_CHECK_DEBUG_TOKEN ?? '').trim();
    // SDK はこのグローバルを initializeAppCheck の中で読む。後から置いても効かない。
    // 文字列なら固定トークン、true なら SDK が生成してコンソールへ出す。
    (globalThis as Record<string, unknown>)['FIREBASE_APPCHECK_DEBUG_TOKEN'] =
      debugToken !== '' ? debugToken : true;
  }

  appCheck = initializeAppCheck(firebaseApp, {
    provider: providerFor(recaptchaSiteKey.trim()),
    isTokenAutoRefreshEnabled: true,
  });

  return providersFor(appCheck);
}

function providersFor(instance: AppCheck): AppCheckProviders {
  return {
    tokenProvider: async () => (await getToken(instance)).token,
    // リプレイ保護（#155・#366）。placesProxy はサーバが consume:true で検証する。
    limitedUseTokenProvider: async () =>
      (await getLimitedUseToken(instance)).token,
  };
}

/// 初期化に使うプロバイダ。
///
/// サイトキーが無いのはデバッグのときだけ（[canActivateAppCheck] が保証する）。
/// そこで `ReCaptchaV3Provider('')` を渡してはいけない——`initializeAppCheck` は
/// デバッグモードでも `provider.initialize()` を必ず呼び、reCAPTCHA の読み込みが
/// 'Missing required parameters: sitekey' で倒れる（実ブラウザで確認）。
///
/// トークン取得のほうは確かにデバッグモードで短絡する（getToken /
/// getLimitedUseToken の両方が、プロバイダを呼ばずデバッグトークンを交換する）。
/// 短絡するのは取得だけで、初期化はしない——ここを取り違えていた。
///
/// [CustomProvider] の `initialize` は何もしないので、移植元の `WebDebugProvider`
/// （サイトキー不要のデバッグ用プロバイダ）に相当する器として使える。
function providerFor(siteKey: string): AppCheckOptions['provider'] {
  if (siteKey !== '') return new ReCaptchaV3Provider(siteKey);

  return new CustomProvider({
    // 到達しない。デバッグモードでしかここへ来ず、デバッグモードは取得を短絡する。
    // 黙って空トークンを返すと、短絡が壊れた日に「App Check は通っているのに 401」
    // という読み解きにくい形で出る。
    getToken: () => {
      throw new Error(
        'App Check: デバッグトークンの交換を経由しないトークン取得は、' +
          'サイトキー未設定では行えない（VITE_RECAPTCHA_SITE_KEY を設定すること）',
      );
    },
  });
}
