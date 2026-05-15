import Flutter
import UIKit
import GoogleMaps

@main
@objc class AppDelegate: FlutterAppDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    // TODO: Replace with a real Google Maps SDK iOS API key.
    // See: https://developers.google.com/maps/documentation/ios-sdk/get-api-key
    if let key = ProcessInfo.processInfo.environment["GOOGLE_MAPS_API_KEY"], !key.isEmpty {
      GMSServices.provideAPIKey(key)
    } else {
      GMSServices.provideAPIKey("YOUR_IOS_GOOGLE_MAPS_API_KEY")
    }
    GeneratedPluginRegistrant.register(with: self)
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
