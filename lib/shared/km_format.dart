/// 距離（km）を表示用に整形する。整数なら小数点を省き、端数は 1 桁で丸める。
///
/// 週間目標カード（ホーム）と設定画面のプリセットで同じ体裁を保つための
/// 共有ヘルパー。両所での表記ぶれを防ぐ。
String formatDistanceKm(double km) =>
    km == km.roundToDouble() ? km.toStringAsFixed(0) : km.toStringAsFixed(1);
