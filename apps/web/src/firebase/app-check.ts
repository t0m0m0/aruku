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

export function canActivateAppCheck(options: {
  usesDebugProvider: boolean;
  recaptchaSiteKey: string;
}): boolean {
  return options.usesDebugProvider || options.recaptchaSiteKey.trim() !== '';
}

const unavailableProviders: AppCheckProviders = {
  tokenProvider: () => Promise.resolve(null),
  limitedUseTokenProvider: () => Promise.resolve(null),
};

let appCheck: AppCheck | null = null;
let firebaseApp: FirebaseApp | null = null;

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

  if (import.meta.env.DEV) {
    const debugToken = (import.meta.env.VITE_APP_CHECK_DEBUG_TOKEN ?? '').trim();
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
    limitedUseTokenProvider: async () => (await getLimitedUseToken(instance)).token,
  };
}

function providerFor(siteKey: string): AppCheckOptions['provider'] {
  if (siteKey !== '') return new ReCaptchaV3Provider(siteKey);

  return new CustomProvider({
    getToken: () => {
      throw new Error(
        'App Check: デバッグトークンの交換を経由しないトークン取得は、' +
          'サイトキー未設定では行えない（VITE_RECAPTCHA_SITE_KEY を設定すること）',
      );
    },
  });
}
