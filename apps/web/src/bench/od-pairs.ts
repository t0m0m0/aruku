// 厳密走査の A/B 計測（#462）に使う出発地・目的地の組。
//
// 時刻表（ODPT の GTFS）を持つ JR東日本・京王・東武・相鉄・東京メトロ・都営が主役に
// なる組を選んである。東急・小田急・京急・西武は時刻表が無いので主役にしない
// （docs/spec/route-optimization.md §3.9）。座標は駅そのものではなく、駅から少し
// 離れた地点にしてある——駅前ちょうどだとアクセス徒歩がほぼ0で、どこで乗るかを
// 選ぶ余地が無い。

export interface BenchPlace {
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
}

export interface OdPair {
  readonly id: string;
  readonly origin: BenchPlace;
  readonly destination: BenchPlace;
  /// 主役になるはずの路線（集計の読み手向けの覚え書き。検索には使わない）。
  readonly lines?: string;
}

export const benchPairs: readonly OdPair[] = [
  {
    id: 'kamata-uenopark',
    lines: 'JR京浜東北線・山手線',
    origin: { name: '蒲田駅', lat: 35.5625, lng: 139.7161 },
    destination: { name: '上野公園', lat: 35.7148, lng: 139.7737 },
  },
  {
    id: 'akabane-shinagawa',
    lines: 'JR京浜東北線',
    origin: { name: '赤羽駅東口', lat: 35.7785, lng: 139.7225 },
    destination: { name: '品川駅港南口', lat: 35.6278, lng: 139.7414 },
  },
  {
    id: 'kichijoji-gyoen',
    lines: 'JR中央線',
    origin: { name: '井の頭恩賜公園', lat: 35.6997, lng: 139.5737 },
    destination: { name: '新宿御苑', lat: 35.6852, lng: 139.7101 },
  },
  {
    id: 'funabashi-kinshicho',
    lines: 'JR総武線',
    origin: { name: '船橋駅', lat: 35.7018, lng: 139.9853 },
    destination: { name: '錦糸公園', lat: 35.6985, lng: 139.8130 },
  },
  {
    id: 'yokohama-kawasaki',
    lines: 'JR東海道線・京浜東北線',
    origin: { name: '横浜駅西口', lat: 35.4661, lng: 139.6200 },
    destination: { name: '川崎駅東口', lat: 35.5305, lng: 139.7000 },
  },
  {
    id: 'omiya-ikebukuro',
    lines: 'JR埼京線・湘南新宿ライン',
    origin: { name: '大宮駅西口', lat: 35.9063, lng: 139.6205 },
    destination: { name: '池袋西口公園', lat: 35.7305, lng: 139.7088 },
  },
  {
    id: 'chofu-shinjuku',
    lines: '京王線',
    origin: { name: '調布駅', lat: 35.6518, lng: 139.5440 },
    destination: { name: '新宿中央公園', lat: 35.6898, lng: 139.6905 },
  },
  {
    id: 'hachioji-seiseki',
    lines: '京王線',
    origin: { name: '京王八王子駅', lat: 35.6575, lng: 139.3438 },
    destination: { name: '聖蹟桜ヶ丘駅', lat: 35.6508, lng: 139.4469 },
  },
  {
    id: 'shimokita-kichijoji',
    lines: '京王井の頭線',
    origin: { name: '下北沢駅', lat: 35.6614, lng: 139.6680 },
    destination: { name: '吉祥寺駅南口', lat: 35.7020, lng: 139.5800 },
  },
  {
    id: 'kitasenju-asakusa',
    lines: '東武スカイツリーライン',
    origin: { name: '北千住駅西口', lat: 35.7497, lng: 139.8030 },
    destination: { name: '浅草寺', lat: 35.7148, lng: 139.7967 },
  },
  {
    id: 'kasukabe-kitasenju',
    lines: '東武スカイツリーライン',
    origin: { name: '春日部駅', lat: 35.9800, lng: 139.7524 },
    destination: { name: '北千住駅東口', lat: 35.7490, lng: 139.8070 },
  },
  {
    id: 'narimasu-ikebukuro',
    lines: '東武東上線',
    origin: { name: '成増駅', lat: 35.7778, lng: 139.6313 },
    destination: { name: '池袋駅東口', lat: 35.7295, lng: 139.7130 },
  },
  {
    id: 'ebina-yokohama',
    lines: '相鉄本線',
    origin: { name: '海老名駅', lat: 35.4526, lng: 139.3906 },
    destination: { name: '横浜駅西口', lat: 35.4661, lng: 139.6200 },
  },
  {
    id: 'futamatagawa-yokohama',
    lines: '相鉄本線',
    origin: { name: '二俣川駅', lat: 35.4636, lng: 139.5326 },
    destination: { name: '横浜駅きた西口', lat: 35.4680, lng: 139.6215 },
  },
  {
    id: 'nakano-otemachi',
    lines: '東京メトロ東西線',
    origin: { name: '中野駅北口', lat: 35.7070, lng: 139.6657 },
    destination: { name: '皇居東御苑', lat: 35.6852, lng: 139.7578 },
  },
  {
    id: 'shibuya-ginza',
    lines: '東京メトロ銀座線',
    origin: { name: '渋谷駅', lat: 35.6580, lng: 139.7016 },
    destination: { name: '銀座四丁目', lat: 35.6717, lng: 139.7650 },
  },
  {
    id: 'nakameguro-ueno',
    lines: '東京メトロ日比谷線',
    origin: { name: '中目黒駅', lat: 35.6440, lng: 139.6990 },
    destination: { name: '上野駅', lat: 35.7138, lng: 139.7773 },
  },
  {
    id: 'shinjuku-motoyawata',
    lines: '都営新宿線',
    origin: { name: '新宿三丁目', lat: 35.6905, lng: 139.7050 },
    destination: { name: '本八幡駅', lat: 35.7213, lng: 139.9270 },
  },
  {
    id: 'oshiage-sengakuji',
    lines: '都営浅草線',
    origin: { name: '押上駅', lat: 35.7101, lng: 139.8132 },
    destination: { name: '泉岳寺', lat: 35.6386, lng: 139.7401 },
  },
  {
    id: 'hikarigaoka-daimon',
    lines: '都営大江戸線',
    origin: { name: '光が丘公園', lat: 35.7620, lng: 139.6290 },
    destination: { name: '芝公園', lat: 35.6560, lng: 139.7490 },
  },
];
