/// Transit API が返す駅座標のうち、実際の駅から大きくずれているものと、その正しい座標（#515）。
export interface StationCoordCorrection {
  /// 表を読む人のための駅 id。突き合わせには使わない（[from] で引く）。
  readonly station: string;
  readonly name: string;
  /// Transit API が返す、ずれた座標 [緯度, 経度]。
  readonly from: readonly [number, number];
  /// 正しい座標 [緯度, 経度]。
  readonly to: readonly [number, number];
  readonly offsetM: number;
}
