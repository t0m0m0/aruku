export type OdptKeyName = 'ODPT_CENTER_KEY' | 'ODPT_CHALLENGE_KEY';

export type PackGroup = 'challenge' | 'permanent' | 'minitokyo3d';

export const PACK_GROUPS: readonly PackGroup[] = ['challenge', 'permanent', 'minitokyo3d'];

export interface MiniTokyo3dSource {
  commit: string;
  operators: readonly string[];
}

export const MINI_TOKYO_3D: MiniTokyo3dSource = {
  commit: 'fa7833f18a288aeca171b68892bb7f67e229e4ca',
  operators: [
    'Tokyu',
    'Odakyu',
    'OdakyuHakone',
    'Keikyu',
    'Seibu',
    'Keisei',
    'Hokuso',
    'Shibayama',
    'Minatomirai',
    'SaitamaRailway',
    'ToyoRapid',
    'TokyoMonorail',
    'Yurikamome',
    'YokohamaSeaside',
    'ChibaMonorail',
    'SaitamaTransit',
    'ShonanMonorail',
    'JR-Central',
    'KantoRailway',
    'Ryutetsu',
    'Kominato',
    'Isumi',
    'Choshi',
    'KashimaRinkai',
    'Hitachinaka',
    'Moka',
    'UtsunomiyaLightRail',
    'Enoden',
    'IzuHakone',
    'Izukyu',
    'Fujikyu',
    'Chichibu',
    'Jomo',
    'Joshin',
    'WataraseKeikoku',
    'Yamaman',
  ],
};

export const miniTokyo3dDataUrl = (commit: string, path: string): string =>
  `https://raw.githubusercontent.com/nagix/mini-tokyo-3d/${commit}/data/${path}`;

export interface OdptFeed {
  id: string;
  url: string;
  key: OdptKeyName | null;
  group: PackGroup;
  routeName?: (gtfsRouteName: string) => string;
}

export const ODPT_FEEDS: readonly OdptFeed[] = [
  {
    id: 'JR-East',
    url: 'https://api-challenge.odpt.org/api/v4/files/JR-East/data/JR-East-Train-GTFS.zip',
    key: 'ODPT_CHALLENGE_KEY',
    group: 'challenge',
  },
  {
    id: 'Keio',
    url: 'https://api-challenge.odpt.org/api/v4/files/Keio/data/Keio-Train-GTFS.zip',
    key: 'ODPT_CHALLENGE_KEY',
    group: 'challenge',
  },
  {
    id: 'Tobu',
    url: 'https://api-challenge.odpt.org/api/v4/files/Tobu/data/Tobu-Train-GTFS.zip',
    key: 'ODPT_CHALLENGE_KEY',
    group: 'challenge',
  },
  {
    id: 'Sotetsu',
    url: 'https://api-challenge.odpt.org/api/v4/files/Sotetsu/data/Sotetsu-Train-GTFS.zip',
    key: 'ODPT_CHALLENGE_KEY',
    group: 'challenge',
  },
  {
    id: 'TokyoMetro',
    url: 'https://api.odpt.org/api/v4/files/TokyoMetro/data/TokyoMetro-Train-GTFS.zip',
    key: 'ODPT_CENTER_KEY',
    group: 'permanent',
  },
  {
    id: 'MIR',
    url: 'https://api.odpt.org/api/v4/files/MIR/data/MIR-Train-GTFS.zip',
    key: 'ODPT_CENTER_KEY',
    group: 'permanent',
  },
  {
    id: 'TWR',
    url: 'https://api.odpt.org/api/v4/files/TWR/data/TWR-Train-GTFS.zip',
    key: 'ODPT_CENTER_KEY',
    group: 'permanent',
  },
  {
    id: 'TamaMonorail',
    url: 'https://api.odpt.org/api/v4/files/TamaMonorail/data/TamaMonorail-Train-GTFS.zip',
    key: 'ODPT_CENTER_KEY',
    group: 'permanent',
  },
  {
    id: 'YokohamaMunicipal',
    url: 'https://api.odpt.org/api/v4/files/odpt/YokohamaMunicipal/Train.zip?date=current',
    key: 'ODPT_CENTER_KEY',
    group: 'permanent',
    routeName: yokohamaLineName,
  },
  {
    id: 'Toei',
    url: 'https://api-public.odpt.org/api/v4/files/Toei/data/Toei-Train-GTFS.zip',
    key: null,
    group: 'permanent',
  },
];

function yokohamaLineName(gtfsRouteName: string): string {
  if (gtfsRouteName.startsWith('【BL】')) return 'ブルーライン';
  if (gtfsRouteName.startsWith('【GL】')) return 'グリーンライン';
  return gtfsRouteName;
}

export const packObjectPath = (group: PackGroup): string => `${group}/timetable-pack.json.gz`;
