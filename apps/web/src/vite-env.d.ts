/// <reference types="vite/client" />

declare module 'virtual:aruku-fonts.css';

interface ImportMetaEnv {
  readonly VITE_PROXY_BASE_URL?: string;

  readonly VITE_TRANSIT_API_BASE_URL?: string;

  readonly VITE_FIREBASE_WEB_API_KEY?: string;
  readonly VITE_FIREBASE_WEB_APP_ID?: string;

  readonly VITE_RECAPTCHA_SITE_KEY?: string;

  readonly VITE_MAPS_WEB_API_KEY?: string;

  readonly VITE_APP_CHECK_DEBUG_TOKEN?: string;

  readonly VITE_EXACT_WALK_MAX?: string;
  readonly VITE_RIDE_DEPARTURES?: string;
}
