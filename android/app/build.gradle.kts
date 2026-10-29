import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

// Firebase Cloud Messaging (docs/PUSH_FCM.md): the owner's google-services.json (gitignored) turns it on. Without it the
// app builds as before and simply never registers for Firebase wake-ups.
val firebaseConfigured = file("google-services.json").exists()
if (firebaseConfigured) apply(plugin = "com.google.gms.google-services")
// A release must not quietly ship without Firebase wake-ups: release builds stop here unless the file is present, or
// the build says on purpose that it's a check build without Firebase (-Pmeldiq.allowNoFirebase=true, as CI does: it
// has no google-services.json and never publishes what it builds). Debug builds are unaffected.
val allowNoFirebase = (project.findProperty("meldiq.allowNoFirebase") as String?)?.trim() == "true"
val checkFirebaseForRelease = tasks.register("checkFirebaseForRelease") {
    val configured = firebaseConfigured
    val allowed = allowNoFirebase
    doLast {
        if (!configured && !allowed) {
            throw GradleException(
                "android/app/google-services.json is missing, so this release would have no Firebase wake-ups (docs/PUSH_FCM.md). " +
                    "Put the owner's file there, or pass -Pmeldiq.allowNoFirebase=true for a build that won't be published.",
            )
        }
    }
}
tasks.matching { it.name == "preReleaseBuild" }.configureEach { dependsOn(checkFirebaseForRelease) }

// The app's default server address, per environment (docs/ENVIRONMENTS.md). People can still pick another server.
//   meldiq.environment            development (debug builds' default) | staging | production (release builds' default)
//   meldiq.apiBaseUrl.<environment>  the address for that environment: gradle -P… or android/local.properties
// Production stays on the current live relay until the Meldiq API hostname exists and its rollout is approved; staging
// has no default (set it); development is this computer, reached from a phone through `adb reverse tcp:8080 tcp:8080`.
// griip.serverUrl (older local.properties) still sets the development address.
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun setting(name: String): String? =
    ((project.findProperty(name) as String?) ?: localProps.getProperty(name))?.trim()?.takeIf { it.isNotEmpty() }

val environments = setOf("development", "staging", "production")
val endpointDefaults = mapOf(
    "production" to "https://msg.meldiq.app", // since 2026-10-22; msg.griipbuddy.cloud still answers for older installs
    "development" to "http://localhost:8080",
)
fun apiBaseUrl(environment: String): String {
    val url = setting("meldiq.apiBaseUrl.$environment")
        ?: (if (environment == "development") setting("griip.serverUrl") else null)
        ?: endpointDefaults[environment]
        ?: throw GradleException("Set meldiq.apiBaseUrl.$environment (gradle -P or android/local.properties) to build for $environment")
    if (environment != "development" && !url.startsWith("https://")) throw GradleException("meldiq.apiBaseUrl.$environment must use https://")
    return url.trimEnd('/')
}
val debugEnvironment = setting("meldiq.environment") ?: "development"
// A release build is never "development": it talks to a TLS server only.
val releaseEnvironment = setting("meldiq.environment")?.takeIf { it != "development" } ?: "production"
require(debugEnvironment in environments && releaseEnvironment in environments) { "meldiq.environment must be one of $environments" }

android {
    // Robolectric screenshot tests read the app's resources (strings, fonts, drawables).
    testOptions { unitTests.isIncludeAndroidResources = true }
    // The app has its own language setting (docs/LANGUAGES.md): every language must be in every install, so the Play
    // bundle isn't split by language.
    bundle {
        language { enableSplit = false }
    }
    namespace = "com.meldiq.android"
    compileSdk = 36

    defaultConfig {
        // Meldiq (2026-10-19 rebrand; the owner chose com.meldiq.android to match meldiq.app). A new application id:
        // Android installs it as a separate app beside Orbit (com.griipbuddy.Orbit, its Play listing;
        // com.griipbuddy.orbit before 2026-10-17), Griip Message (com.griipbuddy.message) and the first Meldiq test
        // builds (com.griipbuddy.meldiq, 2026-10-19, never published). App data never moves between them: accounts come back by signing in, by linking
        // the device, or with the recovery key (docs/MELDIQ_REBRAND_2026-10-19.md). Play needs a new app with exactly
        // this (case-sensitive, permanent) package name; the Orbit listing can't be updated to it.
        applicationId = "com.meldiq.android"
        minSdk = 26
        targetSdk = 36
        // 2026-10-29: the floating redesign, server-stored messages (API 0.57) and activity status. Above 28, the newest
        // code used so far (0.4.8).
        versionCode = 30
        versionName = "0.7.0-beta"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // Not the default "<applicationId>.test": that is the side-by-side debug build's id ("Meldiq Test").
        testApplicationId = "com.meldiq.android.androidtest"
        manifestPlaceholders["appLabel"] = "@string/app_name"
        vectorDrawables.useSupportLibrary = true
        // Ship only ABIs modern phones/emulators use (drops legacy mips/armeabi/x86 from dependencies).
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64") }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            buildConfigField("String", "DEFAULT_SERVER_URL", "\"${apiBaseUrl(debugEnvironment)}\"")
            buildConfigField("String", "MELDIQ_ENVIRONMENT", "\"$debugEnvironment\"")
            // -Pmeldiq.sideBySide=true: a debug build that installs beside a Meldiq release (com.meldiq.android.test,
            // "Meldiq Test") instead of clashing with its signature. Off by default.
            if (project.findProperty("meldiq.sideBySide") == "true") {
                applicationIdSuffix = ".test"
                manifestPlaceholders["appLabel"] = "Meldiq Test"
            }
        }
        release {
            buildConfigField("String", "DEFAULT_SERVER_URL", "\"${apiBaseUrl(releaseEnvironment)}\"")
            buildConfigField("String", "MELDIQ_ENVIRONMENT", "\"$releaseEnvironment\"")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    // The sticker catalogue is shared with the web app (shared/stickers, docs/STICKERS.md): packaged as an asset.
    sourceSets["main"].assets.srcDir("../../shared")
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources {
            excludes += setOf(
                "/META-INF/{AL2.0,LGPL2.1}",
                "META-INF/versions/9/OSGI-INF/MANIFEST.MF",
                "META-INF/DEPENDENCIES",
                "META-INF/LICENSE*",
                "META-INF/NOTICE*",
            )
        }
        jniLibs { useLegacyPackaging = false }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        optIn.addAll(
            "androidx.compose.material3.ExperimentalMaterial3Api",
            "androidx.compose.foundation.layout.ExperimentalLayoutApi",
        )
    }
}

ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.credentials)
    implementation(libs.androidx.credentials.play.services)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.navigation.compose)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.foundation)
    implementation(libs.compose.animation)
    implementation(libs.compose.material3)
    implementation(libs.compose.icons.extended)
    debugImplementation(libs.compose.ui.tooling)

    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)
    implementation(libs.sqlcipher)

    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.bouncycastle)
    implementation(libs.livekit.android)
    implementation(libs.zxing.core)
    // In-app invite QR scanner (T4.2). Apache-2.0, like zxing.
    implementation(libs.camerax.camera2)
    implementation(libs.camerax.lifecycle)
    implementation(libs.camerax.view)
    // Standard/HD video quality for attachments (2026-10-17): re-encodes picked videos on the phone before encryption.
    implementation(libs.media3.transformer)
    implementation(libs.media3.effect)
    implementation(libs.media3.common)
    // Links open in a Custom Tab: the person's own browser, with its safe-browsing and TLS checks (no embedded WebView).
    implementation(libs.androidx.browser)
    // Automatic encrypted backups (docs/BACKUP.md), and fetching after a push wake-up.
    implementation(libs.androidx.work)
    // Push wake-ups through a UnifiedPush distributor such as ntfy (docs/BACKGROUND_DELIVERY.md). Apache-2.0. The
    // connector asks for Tink's JVM build, which brings full protobuf-java and clashes with LiveKit's protobuf-javalite;
    // it only uses Tink's subtle primitives (WebPush keys), so Tink's Android build (no protobuf at all) stands in.
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    implementation(libs.unifiedpush.connector) { exclude(group = "com.google.crypto.tink", module = "tink") }
    implementation(libs.tink.android)
    implementation(libs.play.billing.ktx)
    // Message translation on the phone (docs/LANGUAGES.md › Translation): message text never leaves the device; only the
    // language models are downloaded, after the person agrees.
    implementation(libs.mlkit.translate)
    implementation(libs.mlkit.language.id)

    testImplementation(libs.junit)
    // Screenshots of the design on the JVM (Robolectric's native graphics), run with -Pmeldiq.screenshots=true.
    testImplementation(libs.robolectric)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.sqlite.jdbc) // runs Room migration SQL on the JVM (MigrationsTest)
    testImplementation(libs.okhttp.mockwebserver) // resumable-download tests

    // On-device tests (src/androidTest): run them on the emulator only, e.g. ANDROID_SERIAL=emulator-5554, because
    // connectedAndroidTest installs this debug build and uninstalls it afterwards (docs/TESTING.md).
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.espresso)
    debugImplementation(libs.compose.ui.test.manifest)
}

// Screenshot tests (src/test/.../screenshots) run only when asked: ./gradlew :app:testDebugUnitTest -Pmeldiq.screenshots=true
tasks.withType<Test>().configureEach {
    systemProperty("meldiq.screenshots", (project.findProperty("meldiq.screenshots") ?: "false").toString())
    systemProperty("meldiq.screenshots.dir", layout.buildDirectory.dir("screenshots").get().asFile.absolutePath)
}
