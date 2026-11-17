// 時刻表パックの取得元。ODPT の鉄道 GTFS（#456 の「対象データ」の表）と、
// ODPT で列車をつなげない・ODPT に無い事業者を補う mini-tokyo-3d（#510）。
//
// 東急・小田急・京急・西武は ODPT に駅時刻表しか無く（列車番号も無い）、列車をつなげない。

export type OdptKeyName = "ODPT_CENTER_KEY" | "ODPT_CHALLENGE_KEY";

/**
 * challenge: チャレンジ限定ライセンス（2027-03-12 まで。期限後に消す・#463）
 * permanent: 公共交通オープンデータ基本ライセンス・CC BY 4.0
 * minitokyo3d: mini-tokyo-3d の時刻表（MIT・Copyright (c) 2019-2025 Akihiko Kusanagi）。
 *   README はデータの出典を ODPT としていて、時刻表そのものの権利関係は確かめていない（#510）。
 *   問題が分かったらグループごと外せるよう、ODPT とは別のパックにしている。
 */
export type PackGroup = "challenge" | "permanent" | "minitokyo3d";

export const PACK_GROUPS: readonly PackGroup[] = ["challenge", "permanent", "minitokyo3d"];

export interface MiniTokyo3dSource {
  commit: string;
  /** railways の ID の先頭。ODPT から取っている事業者は入れない（同じ列車が2本ずつ入る）。 */
  operators: readonly string[];
}

/** ダイヤ改正で mini-tokyo-3d の時刻表が直ったら、commit を上げる。 */
export const MINI_TOKYO_3D: MiniTokyo3dSource = {
  commit: "fa7833f18a288aeca171b68892bb7f67e229e4ca",
  // railways.json の事業者のうち、ODPT から取っている10事業者を除いた全部（2026-11 時点）。
  operators: [
    "Tokyu",
    "Odakyu",
    "OdakyuHakone",
    "Keikyu",
    "Seibu",
    "Keisei",
    "Hokuso",
    "Shibayama",
    "Minatomirai",
    "SaitamaRailway",
    "ToyoRapid",
    "TokyoMonorail",
    "Yurikamome",
    "YokohamaSeaside",
    "ChibaMonorail",
    "SaitamaTransit",
    "ShonanMonorail",
    "JR-Central",
    "KantoRailway",
    "Ryutetsu",
    "Kominato",
    "Isumi",
    "Choshi",
    "KashimaRinkai",
    "Hitachinaka",
    "Moka",
    "UtsunomiyaLightRail",
    "Enoden",
    "IzuHakone",
    "Izukyu",
    "Fujikyu",
    "Chichibu",
    "Jomo",
    "Joshin",
    "WataraseKeikoku",
    "Yamaman",
  ],
};

// リポジトリ全体の zip を取らないのは、data/ 以外（地図・画像・ビルド成果物）が大半を占めるため。
export const miniTokyo3dDataUrl = (commit: string, path: string): string =>
  `https://raw.githubusercontent.com/nagix/mini-tokyo-3d/${commit}/data/${path}`;

export interface OdptFeed {
  id: string;
  url: string;
  /** acl:consumerKey に付けるキーの Secret 名。null はキー不要。 */
  key: OdptKeyName | null;
  group: PackGroup;
  /** GTFS の路線名（route_long_name か route_short_name）を、画面に出す路線名へ写す。 */
  routeName?: (gtfsRouteName: string) => string;
}

export const ODPT_FEEDS: readonly OdptFeed[] = [
  {
    id: "JR-East",
    url: "https://api-challenge.odpt.org/api/v4/files/JR-East/data/JR-East-Train-GTFS.zip",
    key: "ODPT_CHALLENGE_KEY",
    group: "challenge",
  },
  {
    id: "Keio",
    url: "https://api-challenge.odpt.org/api/v4/files/Keio/data/Keio-Train-GTFS.zip",
    key: "ODPT_CHALLENGE_KEY",
    group: "challenge",
  },
  {
    id: "Tobu",
    url: "https://api-challenge.odpt.org/api/v4/files/Tobu/data/Tobu-Train-GTFS.zip",
    key: "ODPT_CHALLENGE_KEY",
    group: "challenge",
  },
  {
    id: "Sotetsu",
    url: "https://api-challenge.odpt.org/api/v4/files/Sotetsu/data/Sotetsu-Train-GTFS.zip",
    key: "ODPT_CHALLENGE_KEY",
    group: "challenge",
  },
  {
    id: "TokyoMetro",
    url: "https://api.odpt.org/api/v4/files/TokyoMetro/data/TokyoMetro-Train-GTFS.zip",
    key: "ODPT_CENTER_KEY",
    group: "permanent",
  },
  {
    id: "MIR",
    url: "https://api.odpt.org/api/v4/files/MIR/data/MIR-Train-GTFS.zip",
    key: "ODPT_CENTER_KEY",
    group: "permanent",
  },
  {
    id: "TWR",
    url: "https://api.odpt.org/api/v4/files/TWR/data/TWR-Train-GTFS.zip",
    key: "ODPT_CENTER_KEY",
    group: "permanent",
  },
  {
    id: "TamaMonorail",
    url: "https://api.odpt.org/api/v4/files/TamaMonorail/data/TamaMonorail-Train-GTFS.zip",
    key: "ODPT_CENTER_KEY",
    group: "permanent",
  },
  {
    id: "YokohamaMunicipal",
    // ほかの事業者と同じ `/files/<事業者>/data/<事業者>-Train-GTFS.zip` の形は 404。
    // date=current はその日に有効な版（Train-<版>.zip）への 302 で、外すと 404。
    url: "https://api.odpt.org/api/v4/files/odpt/YokohamaMunicipal/Train.zip?date=current",
    key: "ODPT_CENTER_KEY",
    group: "permanent",
    routeName: yokohamaLineName,
  },
  {
    id: "Toei",
    url: "https://api-public.odpt.org/api/v4/files/Toei/data/Toei-Train-GTFS.zip",
    key: null,
    group: "permanent",
  },
];

// route_long_name が「【BL】【快速】あざみ野　→　湘南台」のような向き・種別つきの系統名で、
// route_short_name は空。種別まで落とすのは、ほかのフィードの路線名（「銀座線」など）が
// 種別を持たないのにそろえるため。向きは行先（trip_headsign）が持つ。
function yokohamaLineName(gtfsRouteName: string): string {
  if (gtfsRouteName.startsWith("【BL】")) return "ブルーライン";
  if (gtfsRouteName.startsWith("【GL】")) return "グリーンライン";
  return gtfsRouteName;
}

export const packObjectPath = (group: PackGroup): string => `${group}/timetable-pack.json.gz`;
