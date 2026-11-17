// 厳密走査の計測に使う出発地・目的地の組。
//
// benchPairs は A/B 計測（#462）の組で、ODPT の時刻表を持つ JR東日本・京王・東武・相鉄・
// 東京メトロ・都営が主役になる。組を選んだ当時は東急・小田急・京急・西武に時刻表が無かった。
// #462 の数字と比べられるよう、mini-tokyo-3d の時刻表が入った後（#511）も組は変えない。
// privateRailPairs は、その私鉄などが主役になる組で、再生ベンチ（#513）だけが回す。
//
// 座標は駅そのものではなく、駅から少し離れた地点にしてある——駅前ちょうどだとアクセス
// 徒歩がほぼ0で、どこで乗るかを選ぶ余地が無い。

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
    destination: { name: '錦糸公園', lat: 35.6985, lng: 139.813 },
  },
  {
    id: 'yokohama-kawasaki',
    lines: 'JR東海道線・京浜東北線',
    origin: { name: '横浜駅西口', lat: 35.4661, lng: 139.62 },
    destination: { name: '川崎駅東口', lat: 35.5305, lng: 139.7 },
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
    origin: { name: '調布駅', lat: 35.6518, lng: 139.544 },
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
    origin: { name: '下北沢駅', lat: 35.6614, lng: 139.668 },
    destination: { name: '吉祥寺駅南口', lat: 35.702, lng: 139.58 },
  },
  {
    id: 'kitasenju-asakusa',
    lines: '東武スカイツリーライン',
    origin: { name: '北千住駅西口', lat: 35.7497, lng: 139.803 },
    destination: { name: '浅草寺', lat: 35.7148, lng: 139.7967 },
  },
  {
    id: 'kasukabe-kitasenju',
    lines: '東武スカイツリーライン',
    origin: { name: '春日部駅', lat: 35.98, lng: 139.7524 },
    destination: { name: '北千住駅東口', lat: 35.749, lng: 139.807 },
  },
  {
    id: 'narimasu-ikebukuro',
    lines: '東武東上線',
    origin: { name: '成増駅', lat: 35.7778, lng: 139.6313 },
    destination: { name: '池袋駅東口', lat: 35.7295, lng: 139.713 },
  },
  {
    id: 'ebina-yokohama',
    lines: '相鉄本線',
    origin: { name: '海老名駅', lat: 35.4526, lng: 139.3906 },
    destination: { name: '横浜駅西口', lat: 35.4661, lng: 139.62 },
  },
  {
    id: 'futamatagawa-yokohama',
    lines: '相鉄本線',
    origin: { name: '二俣川駅', lat: 35.4636, lng: 139.5326 },
    destination: { name: '横浜駅きた西口', lat: 35.468, lng: 139.6215 },
  },
  {
    id: 'nakano-otemachi',
    lines: '東京メトロ東西線',
    origin: { name: '中野駅北口', lat: 35.707, lng: 139.6657 },
    destination: { name: '皇居東御苑', lat: 35.6852, lng: 139.7578 },
  },
  {
    id: 'shibuya-ginza',
    lines: '東京メトロ銀座線',
    origin: { name: '渋谷駅', lat: 35.658, lng: 139.7016 },
    destination: { name: '銀座四丁目', lat: 35.6717, lng: 139.765 },
  },
  {
    id: 'nakameguro-ueno',
    lines: '東京メトロ日比谷線',
    origin: { name: '中目黒駅', lat: 35.644, lng: 139.699 },
    destination: { name: '上野駅', lat: 35.7138, lng: 139.7773 },
  },
  {
    id: 'shinjuku-motoyawata',
    lines: '都営新宿線',
    origin: { name: '新宿三丁目', lat: 35.6905, lng: 139.705 },
    destination: { name: '本八幡駅', lat: 35.7213, lng: 139.927 },
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
    origin: { name: '光が丘公園', lat: 35.762, lng: 139.629 },
    destination: { name: '芝公園', lat: 35.656, lng: 139.749 },
  },
];

/// mini-tokyo-3d の時刻表（#511）で厳密走査に入った事業者が主役になる組。
export const privateRailPairs: readonly OdPair[] = [
  {
    id: 'jiyugaoka-aoyama',
    lines: '東急東横線',
    origin: { name: '自由が丘（熊野神社）', lat: 35.61, lng: 139.672 },
    destination: { name: '青山学院大学', lat: 35.6605, lng: 139.7105 },
  },
  {
    id: 'futakotamagawa-sangenjaya',
    lines: '東急田園都市線',
    origin: { name: '二子玉川公園', lat: 35.6135, lng: 139.631 },
    destination: { name: '世田谷公園', lat: 35.6405, lng: 139.6835 },
  },
  {
    id: 'machida-shinjukupark',
    lines: '小田急小田原線',
    origin: { name: '町田市役所', lat: 35.5465, lng: 139.4385 },
    destination: { name: '新宿中央公園', lat: 35.6895, lng: 139.69 },
  },
  {
    id: 'kanazawabunko-sengakuji',
    lines: '京急本線',
    origin: { name: '金沢文庫（称名寺）', lat: 35.3375, lng: 139.626 },
    destination: { name: '高輪ゲートウェイ周辺', lat: 35.6355, lng: 139.741 },
  },
  {
    id: 'shibakoen-haneda',
    lines: '東京モノレール・京急空港線',
    origin: { name: '芝公園', lat: 35.655, lng: 139.75 },
    destination: { name: '羽田空港第3ターミナル', lat: 35.544, lng: 139.768 },
  },
  {
    id: 'tokorozawa-toshimaku',
    lines: '西武池袋線',
    origin: { name: '所沢航空記念公園', lat: 35.799, lng: 139.472 },
    destination: { name: '豊島区役所', lat: 35.726, lng: 139.716 },
  },
  {
    id: 'kodaira-waseda',
    lines: '西武新宿線',
    origin: { name: '小平霊園', lat: 35.74, lng: 139.495 },
    destination: { name: '早稲田大学', lat: 35.709, lng: 139.7195 },
  },
  {
    id: 'keiseiyawata-shinobazu',
    lines: '京成本線',
    origin: { name: '八幡（市川市役所）', lat: 35.7215, lng: 139.93 },
    destination: { name: '不忍池', lat: 35.712, lng: 139.77 },
  },
  {
    id: 'shinkamagaya-skytree',
    lines: '北総線・京成押上線',
    origin: { name: '新鎌ヶ谷（鎌ヶ谷市役所）', lat: 35.7765, lng: 140.001 },
    destination: { name: '東京スカイツリー', lat: 35.7101, lng: 139.8107 },
  },
  {
    id: 'yachiyomidorigaoka-nihombashi',
    lines: '東葉高速線・東京メトロ東西線',
    origin: { name: '八千代緑が丘（ふるさとステーション）', lat: 35.728, lng: 140.06 },
    destination: { name: '日本橋', lat: 35.6835, lng: 139.774 },
  },
];

/// 再生ベンチ（#504・#513）が回す組。
export const replayPairs: readonly OdPair[] = [...benchPairs, ...privateRailPairs];
