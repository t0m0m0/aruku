const profileMode = 'profile';

export const kDebugMode = import.meta.env.DEV;

export const kReleaseMode = import.meta.env.PROD && import.meta.env.MODE !== profileMode;
