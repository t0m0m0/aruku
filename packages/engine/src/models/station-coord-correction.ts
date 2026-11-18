export interface StationCoordCorrection {
  readonly station: string;
  readonly name: string;
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
  readonly offsetM: number;
}
