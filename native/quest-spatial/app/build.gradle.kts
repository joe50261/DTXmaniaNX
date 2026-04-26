plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "com.dtxmania.quest"
    compileSdk = libs.versions.compileSdk.get().toInt()
    // Match the NDK version installed by .github/workflows/android.yml.
    // Bumping this requires a matching bump in CI.
    ndkVersion = "26.1.10909125"

    defaultConfig {
        applicationId = "com.dtxmania.quest"
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = 1
        versionName = "0.1.0-phase0"

        ndk {
            abiFilters += listOf("arm64-v8a")
        }

        externalNativeBuild {
            cmake {
                // -Werror intentionally NOT set: NDK headers occasionally
                // emit warnings (deprecation, unused-parameter on
                // AAudio_convertResultToText shims) that would fail a
                // CI build for reasons orthogonal to our own code.
                cppFlags += listOf("-std=c++17", "-Wall", "-Wextra")
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    sourceSets {
        getByName("main") {
            java.srcDirs("src/main/kotlin")
        }
        getByName("test") {
            java.srcDirs("src/test/kotlin")
        }
    }

    testOptions {
        unitTests.all {
            it.useJUnitPlatform()
        }
        // Robolectric needs the merged test resources + manifest so it
        // can construct an Application instance and resolve resources
        // during JVM unit tests.
        unitTests.isIncludeAndroidResources = true
    }
}

dependencies {
    implementation(libs.androidx.documentfile)
    implementation(libs.androidx.activity)

    // Meta Spatial SDK (verified against
    // meta-quest/Meta-Spatial-SDK-Samples StarterSample at 0.12.0).
    // Minimum module set for Phase 4 (passthrough scene + lighting).
    // The com.meta.spatial.plugin Gradle plugin is intentionally NOT
    // applied — its only job is wiring Meta Spatial Editor scene
    // exports + hot reload, neither of which we use yet. If we later
    // adopt .metaspatial scenes, add `alias(libs.plugins.meta.spatial.plugin)`
    // and a corresponding `spatial { ... }` block here.
    implementation(libs.meta.spatial.sdk)
    implementation(libs.meta.spatial.sdk.vr)
    implementation(libs.meta.spatial.sdk.toolkit)
    implementation(libs.meta.spatial.sdk.isdk)

    // JUnit 5 (Jupiter) drives the platform; junit-vintage-engine lets
    // the same `gradlew testDebugUnitTest` run also pick up the JUnit-4
    // -style Robolectric tests in `io/`. The two engines coexist on the
    // platform without interference.
    testImplementation(libs.junit.jupiter.api)
    testRuntimeOnly(libs.junit.jupiter.engine)
    testRuntimeOnly(libs.junit.vintage.engine)
    testImplementation(libs.junit4)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.ext.junit)
}
