import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Push (FCM) is a build-time switch: it is on only when app/google-services.json exists.
val pushEnabled = file("google-services.json").exists()
if (pushEnabled) {
    apply(plugin = "com.google.gms.google-services")
}

// Release signing. Values come from the environment (CI) or from android/keystore.properties (local, git-ignored):
//   storeFile, storePassword, keyAlias, keyPassword   /   OMPR_KEYSTORE_FILE, OMPR_KEYSTORE_PASSWORD, OMPR_KEY_ALIAS, OMPR_KEY_PASSWORD
// With any of them missing, `assembleRelease` produces an unsigned APK instead of failing.
val signingProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun signingValue(prop: String, env: String): String? = System.getenv(env)?.takeIf { it.isNotBlank() } ?: signingProps.getProperty(prop)
val releaseStoreFile = signingValue("storeFile", "OMPR_KEYSTORE_FILE")
val releaseStorePassword = signingValue("storePassword", "OMPR_KEYSTORE_PASSWORD")
val releaseKeyAlias = signingValue("keyAlias", "OMPR_KEY_ALIAS")
val releaseKeyPassword = signingValue("keyPassword", "OMPR_KEY_PASSWORD")
val hasReleaseSigning = listOf(releaseStoreFile, releaseStorePassword, releaseKeyAlias, releaseKeyPassword).all { it != null }

// The version comes from the release tag (OMPR_VERSION=0.2.0). versionCode = major*10000 + minor*100 + patch.
val appVersion = System.getenv("OMPR_VERSION")?.takeIf { it.isNotBlank() } ?: "0.1.0"
require(Regex("""\d{1,3}\.\d{1,2}\.\d{1,2}""").matches(appVersion)) { "OMPR_VERSION must look like 1.2.3 (got '$appVersion')" }
val appVersionCode = appVersion.split(".").map { it.toInt() }.let { (major, minor, patch) -> major * 10_000 + minor * 100 + patch }

android {
    namespace = "app.ompr"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.ompr"
        minSdk = 28
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersion
        buildConfigField("boolean", "PUSH_ENABLED", pushEnabled.toString())
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = rootProject.file(releaseStoreFile!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ""
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("release")
            // `-PomprAppIdSuffix=.rc` installs a release build next to the real app (separate data), for testing a release build safely.
            (project.findProperty("omprAppIdSuffix") as String?)?.let { applicationIdSuffix = it }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
        freeCompilerArgs += listOf("-opt-in=kotlin.RequiresOptIn")
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "META-INF/versions/**")
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.datastore.preferences)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    debugImplementation(libs.androidx.compose.ui.tooling)

    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.mlkit.barcode)
    implementation(libs.androidx.biometric)
    implementation(libs.androidx.exifinterface)

    implementation(libs.markdown.m3)
    implementation(libs.coil.compose)

    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
