/*
 * The Android app is a Trusted Web Activity: it opens the deployed game
 * (https://dybecks.github.io/the-musicquiz/) full screen in the phone's Chrome.
 * Game changes ship through GitHub Pages; this app only needs a new release
 * when something here changes (name, icon, colours, version, Android settings).
 *
 * Version and signing come from environment variables so CI can set them:
 *   ANDROID_VERSION_CODE   integer, must go up with every Play upload
 *   ANDROID_VERSION_NAME   e.g. 1.2.0
 *   ANDROID_KEYSTORE_PATH, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD
 * Without a keystore, the release build is unsigned (fine for checking that it builds).
 */
plugins {
    id("com.android.application")
}

val keystorePath: String? = System.getenv("ANDROID_KEYSTORE_PATH")?.takeIf { it.isNotBlank() }

android {
    namespace = "io.github.dybecks.musicquiz"
    compileSdk = 36

    defaultConfig {
        // The app id is permanent once published on Google Play.
        applicationId = "io.github.dybecks.musicquiz"
        minSdk = 21
        targetSdk = 36
        versionCode = (System.getenv("ANDROID_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("ANDROID_VERSION_NAME") ?: "0.0.0-dev"
    }

    signingConfigs {
        if (keystorePath != null) {
            create("upload") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("upload")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.5.0")
}
