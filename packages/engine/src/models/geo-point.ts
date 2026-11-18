export class GeoPoint {
  constructor(
    readonly lat: number,
    readonly lng: number,
    readonly heading: number | null = null,
  ) {}

  isAt(other: GeoPoint): boolean {
    return this.lat === other.lat && this.lng === other.lng;
  }
}
