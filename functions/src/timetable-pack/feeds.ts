// 取得する ODPT の鉄道 GTFS（#456 の「対象データ」の表）。
//
// 東急・小田急・京急・西武は駅時刻表しか無く列車をつなげないので対象外。

export type OdptKeyName = "ODPT_CENTER_KEY" | "ODPT_CHALLENGE_KEY";

/**
 * challenge: チャレンジ限定ライセンス（2027-03-12 まで。期限後に消す・#463）
 * permanent: 公共交通オープンデータ基本ライセンス・CC BY 4.0
 */
export type PackGroup = "challenge" | "permanent";

export const PACK_GROUPS: readonly PackGroup[] = ["challenge", "permanent"];

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
