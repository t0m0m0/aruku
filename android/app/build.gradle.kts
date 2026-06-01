import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    // START: FlutterFire Configuration
    id("com.google.gms.google-services")
    // END: FlutterFire Configuration
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Google Maps API key: secrets.properties (リポジトリルート) → 環境変数 → 空文字。
// 空文字でもビルドは通り、地図が表示されないだけ（Dart 側既定はプレースホルダ）。
val secretsFile = rootProject.file("../secrets.properties")
val mapsApiKey: String = (
    if (secretsFile.exists()) {
        Properties().apply { FileInputStream(secretsFile).use { load(it) } }
            .getProperty("MAPS_API_KEY")
    } else {
        null
    }
) ?: System.getenv("MAPS_API_KEY") ?: ""

// リリース署名設定: android/key.properties が存在すれば本番鍵で署名する。
// 未配置の開発環境では null のままとし、`flutter run --release` が debug 鍵で
// 動くよう従来どおりフォールバックする（MAPS_API_KEY と同じ「空でも通る」方針）。
val keystoreProperties: Properties? = rootProject.file("key.properties").let { f ->
    if (f.exists()) Properties().apply { FileInputStream(f).use { load(it) } } else null
}

android {
    namespace = "com.aruku.aruku"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.aruku.aruku"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        manifestPlaceholders["MAPS_API_KEY"] = mapsApiKey
    }

    signingConfigs {
        // key.properties がある場合のみ release 署名設定を生成する。
        keystoreProperties?.let { props ->
            create("release") {
                storeFile = file(props.getProperty("storeFile"))
                storePassword = props.getProperty("storePassword")
                keyAlias = props.getProperty("keyAlias")
                keyPassword = props.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // 本番鍵があればそれで署名。未配置の開発環境では debug 鍵に
            // フォールバックし `flutter run --release` を壊さない。
            signingConfig = if (keystoreProperties != null) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }
}

flutter {
    source = "../.."
}
