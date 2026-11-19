export interface PlacePrediction {
  readonly placeId: string;
  readonly name: string;
  readonly address: string;

  readonly distanceMeters: number | null;
}
