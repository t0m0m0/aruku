export const defaultTransitApiBaseUrl = 'https://api.transit.ls8h.com';

export interface FirebaseConfig {
  readonly apiKey: string;
  readonly appId: string;
  readonly projectId: string;
  readonly messagingSenderId: string;
  readonly authDomain: string;
  readonly storageBucket: string;
}

export interface AppConfig {
  readonly proxyBaseUrl: string;

  readonly transitApiBaseUrl: string;

  readonly firebase: FirebaseConfig;

  readonly recaptchaSiteKey: string;

  readonly mapsApiKey: string;

  readonly exactWalkMax: boolean;

  readonly rideDepartures: boolean;
}

export const appConfig: AppConfig = {
  proxyBaseUrl: import.meta.env.VITE_PROXY_BASE_URL ?? '',
  transitApiBaseUrl: import.meta.env.VITE_TRANSIT_API_BASE_URL ?? defaultTransitApiBaseUrl,
  firebase: {
    apiKey: import.meta.env.VITE_FIREBASE_WEB_API_KEY ?? '',
    appId: import.meta.env.VITE_FIREBASE_WEB_APP_ID ?? '',
    projectId: 'aruku-app',
    messagingSenderId: '174669528481',
    authDomain: 'aruku-app.firebaseapp.com',
    storageBucket: 'aruku-app.firebasestorage.app',
  },
  recaptchaSiteKey: import.meta.env.VITE_RECAPTCHA_SITE_KEY ?? '',
  mapsApiKey: import.meta.env.VITE_MAPS_WEB_API_KEY ?? '',
  exactWalkMax: import.meta.env.VITE_EXACT_WALK_MAX === '1',
  rideDepartures: import.meta.env.VITE_RIDE_DEPARTURES === '1',
};

export const termsOfServiceUrl = '/terms';
export const privacyPolicyUrl = '/privacy';

export const contactUrl = 'https://github.com/t0m0m0/aruku/issues';
