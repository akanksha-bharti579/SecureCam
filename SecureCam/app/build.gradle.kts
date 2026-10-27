plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "com.example.securecam"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "com.example.securecam"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("boolean", "AUTO_CAPTURE", "false")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            optimization {
                enable = false
            }
        }
        // Timing benchmark only (installs beside the normal app as "SecureCam Bench"): long-press TAKE PHOTO runs
        // 100 captures, for phones whose firmware blocks input from adb. The capture pipeline is unchanged.
        create("bench") {
            initWith(getByName("debug"))
            applicationIdSuffix = ".bench"
            versionNameSuffix = "-bench"
            buildConfigField("boolean", "AUTO_CAPTURE", "true")
            matchingFallbacks += listOf("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

dependencies {
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.constraintlayout)
    implementation(libs.androidx.core.ktx)
    implementation(libs.material)
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.androidx.junit)
    val camerax_version = "1.3.0-rc01"
    implementation("androidx.camera:camera-core:${camerax_version}")
    implementation("androidx.camera:camera-camera2:${camerax_version}")
    implementation("androidx.camera:camera-lifecycle:${camerax_version}")
    implementation("androidx.camera:camera-view:${camerax_version}")
    implementation("androidx.exifinterface:exifinterface:1.3.7")

}