import Flutter
import UIKit
import GoogleMaps

@main
@objc class AppDelegate: FlutterAppDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    // Key resolution: env var (flutter run override) → Info.plist GMSApiKey
    // (populated from Secrets.xcconfig). Empty → skip so the app still launches.
    // See README.md "Google Maps セットアップ".
    let envKey = ProcessInfo.processInfo.environment["MAPS_API_KEY"]
    let plistKey = Bundle.main.object(forInfoDictionaryKey: "GMSApiKey") as? String
    let mapsApiKey = ((envKey?.isEmpty == false) ? envKey : plistKey) ?? ""
    if !mapsApiKey.isEmpty {
      GMSServices.provideAPIKey(mapsApiKey)
    }
    GeneratedPluginRegistrant.register(with: self)
    // flutter_local_notifications: アプリ前面でも通知を表示できるよう、
    // 通知センターのデリゲートを設定する。
    if #available(iOS 10.0, *) {
      UNUserNotificationCenter.current().delegate = self as? UNUserNotificationCenterDelegate
    }
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
