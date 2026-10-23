// 取得する ODPT の鉄道 GTFS（#456 の「対象データ」の表）。
//
// 東急・小田急・京急・西武は駅時刻表しか無く列車をつなげないので対象外。
// 横浜市営地下鉄はカタログの URL が 404 だったので保留。

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
    id: "Toei",
    url: "https://api-public.odpt.org/api/v4/files/Toei/data/Toei-Train-GTFS.zip",
    key: null,
    group: "permanent",
  },
];

export const packObjectPath = (group: PackGroup): string => `${group}/timetable-pack.json.gz`;
