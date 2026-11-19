# The Music Quiz for Android

A [Trusted Web Activity](https://developer.chrome.com/docs/android/trusted-web-activity):
a small app that opens the deployed game, <https://dybecks.github.io/the-musicquiz/>,
full screen in the phone's Chrome. The game itself isn't in the app.

| What changed | How it reaches players |
| --- | --- |
| The game (code, songs, layout) | Merge to `main`. GitHub Pages deploys it and the app shows it the next time it opens. No app release. |
| The app: name, icon, colours, Android settings | A new app release, below. |

The project is plain Gradle with [android-browser-helper](https://github.com/GoogleChrome/android-browser-helper);
there's no app code, only `app/src/main/AndroidManifest.xml` and resources. App id:
`io.github.dybecks.musicquiz` (permanent once it's on Google Play).

## Releasing

Push a tag:

```bash
git tag android-v1.0.0 && git push origin android-v1.0.0
```

`.github/workflows/android.yml` then:

1. sets `versionName` from the tag (`1.0.0`) and `versionCode` from the run number (always higher);
2. builds the signed app bundle (`.aab`, for Google Play) and APK (for installing directly);
3. attaches both to a GitHub Release named "Android 1.0.0";
4. uploads the bundle to Google Play's **internal testing** track, as a draft. Promote it to
   closed testing or production in the Play Console.

Pull requests that change `android/` only check that it builds (unsigned).

## One-time setup

### 1. Upload key

Google Play keeps the key that signs the app for users (Play App Signing). We only hold an
*upload key*. Create it once and keep a backup somewhere safe, outside the repository:

```bash
keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 upload.jks   # the value for ANDROID_KEYSTORE_BASE64
```

Repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `upload.jks`, base64 |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | `upload` |
| `ANDROID_KEY_PASSWORD` | Key password |
| `PLAY_SERVICE_ACCOUNT_JSON` | Google Play API service account key (step 3) |

Without the keystore secrets, releases are unsigned and aren't uploaded to Play.

### 2. Google Play Console

1. Create a developer account (one-time fee) and the app, with the id above.
2. Store listing: description, screenshots, icon (`public/icons/icon-512.png`), privacy policy URL
   (needed because of the Spotify login), Data safety form, content rating.
3. Upload the first bundle **by hand** (download it from the first GitHub Release). Google Play's
   API can't create an app's first release; after that, CI uploads.
4. New personal developer accounts must run a closed test with a minimum number of testers for a
   minimum number of days before they can publish to production. The Play Console shows the
   current requirement.

### 3. Uploads from CI

In Google Cloud, create a service account, give it a JSON key, and invite its email in the Play Console
(Users and permissions) with permission to release to testing tracks. Save the JSON as `PLAY_SERVICE_ACCOUNT_JSON`.

### 4. Link the site and the app (no browser bar)

Chrome only hides its address bar when the website confirms it trusts the app. Until then the app
still works, but shows a slim browser bar at the top.

1. Fill in `assetlinks.json` here with the SHA-256 fingerprints from Play Console → Test and release
   → App integrity: the **app signing key** (Play installs) and the **upload key** (APKs installed directly).
2. Serve it at `https://dybecks.github.io/.well-known/assetlinks.json`, the root of the domain. A
   GitHub Pages project site (`/the-musicquiz/`) can't serve that path, so it goes in a repository
   named `dybecks.github.io` (or the game moves to a custom domain, which then also changes
   `hostName`/`launchUrl` in `app/src/main/res/values/strings.xml`).
3. Check it with Google's [Statement List tester](https://developers.google.com/digital-asset-links/tools/generator).

## Building locally

Needs JDK 17 and the Android SDK (Android Studio installs both). Open `android/` in Android Studio, or:

```bash
cd android && ./gradlew assembleDebug   # app/build/outputs/apk/debug/app-debug.apk
```
