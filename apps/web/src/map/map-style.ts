// 移植元: lib/core/theme/aruku_map_style.dart
//
// Wakaba の配色に寄せた Google Maps のスタイル。移植元は JSON 文字列だが、こちらは
// 配列のまま持つ——ライブラリが受け取るのはオブジェクトで、文字列にすると読む側で
// JSON.parse が要り、壊れても型で止まらない。
//
// mapId は使わない。Maps JS API は styles と mapId を排他にしており、mapId を渡すと
// この配色は無視されて Cloud Console 側の設定が勝つ。配色をリポジトリの外へ出すと、
// 移植元と同じ色かどうかがコードから確かめられなくなる。
//
// 色は tokens.css の --map-* と同じ値だが、CSS 変数では書けない。スタイルは Maps API へ
// 渡すデータで、CSS のカスケードの外に居る。

export const arukuWakabaMapStyle: google.maps.MapTypeStyle[] = [
  { elementType: 'geometry', stylers: [{ color: '#efebdd' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#6e6a57' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#fbfcec' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  {
    featureType: 'administrative',
    elementType: 'geometry',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'landscape.man_made',
    elementType: 'geometry',
    stylers: [{ color: '#e5dfcc' }],
  },
  { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  {
    featureType: 'poi.park',
    elementType: 'geometry',
    stylers: [{ color: '#dde7c7' }],
  },
  {
    featureType: 'poi.park',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#6e6a57' }],
  },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
  {
    featureType: 'road',
    elementType: 'labels.icon',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'road.arterial',
    elementType: 'geometry',
    stylers: [{ color: '#f6efd6' }],
  },
  {
    featureType: 'road.highway',
    elementType: 'geometry',
    stylers: [{ color: '#f7e4a0' }],
  },
  {
    featureType: 'road.highway',
    elementType: 'labels',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'transit',
    elementType: 'labels.icon',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'transit.line',
    elementType: 'geometry',
    stylers: [{ color: '#d9d3bf' }],
  },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#bfd3dd' }] },
  {
    featureType: 'water',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#7d93a0' }],
  },
];
