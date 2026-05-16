/// Google Maps style JSON tuned to the Wakaba (若葉) palette.
///
/// Color values mirror [ArukuColors.wakaba] map tokens so the live map keeps
/// the same tone as the stylized placeholder:
/// bg #EFEBDD / road #FFFFFF / major #F7E4A0 / park #DDE7C7 /
/// water #BFD3DD / building #E5DFCC / label #6E6A57.
const String arukuWakabaMapStyle = '''
[
  { "elementType": "geometry", "stylers": [{ "color": "#efebdd" }] },
  { "elementType": "labels.text.fill", "stylers": [{ "color": "#6e6a57" }] },
  { "elementType": "labels.text.stroke", "stylers": [{ "color": "#fbfcec" }] },
  { "elementType": "labels.icon", "stylers": [{ "visibility": "off" }] },
  {
    "featureType": "administrative",
    "elementType": "geometry",
    "stylers": [{ "visibility": "off" }]
  },
  {
    "featureType": "landscape.man_made",
    "elementType": "geometry",
    "stylers": [{ "color": "#e5dfcc" }]
  },
  {
    "featureType": "poi",
    "elementType": "labels",
    "stylers": [{ "visibility": "off" }]
  },
  {
    "featureType": "poi.park",
    "elementType": "geometry",
    "stylers": [{ "color": "#dde7c7" }]
  },
  {
    "featureType": "poi.park",
    "elementType": "labels.text.fill",
    "stylers": [{ "color": "#6e6a57" }]
  },
  {
    "featureType": "road",
    "elementType": "geometry",
    "stylers": [{ "color": "#ffffff" }]
  },
  {
    "featureType": "road",
    "elementType": "labels.icon",
    "stylers": [{ "visibility": "off" }]
  },
  {
    "featureType": "road.arterial",
    "elementType": "geometry",
    "stylers": [{ "color": "#f6efd6" }]
  },
  {
    "featureType": "road.highway",
    "elementType": "geometry",
    "stylers": [{ "color": "#f7e4a0" }]
  },
  {
    "featureType": "road.highway",
    "elementType": "labels",
    "stylers": [{ "visibility": "off" }]
  },
  {
    "featureType": "transit",
    "elementType": "labels.icon",
    "stylers": [{ "visibility": "off" }]
  },
  {
    "featureType": "transit.line",
    "elementType": "geometry",
    "stylers": [{ "color": "#d9d3bf" }]
  },
  {
    "featureType": "water",
    "elementType": "geometry",
    "stylers": [{ "color": "#bfd3dd" }]
  },
  {
    "featureType": "water",
    "elementType": "labels.text.fill",
    "stylers": [{ "color": "#7d93a0" }]
  }
]
''';
