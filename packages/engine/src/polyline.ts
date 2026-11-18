export function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    lat += decodeValue();
    lng += decodeValue();
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;

  function decodeValue(): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
  }
}
