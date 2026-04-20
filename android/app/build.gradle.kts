plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.android)
  alias(libs.plugins.ksp)
}

android {
  namespace = "com.xiaoke.nova"
  compileSdk = 36

  defaultConfig {
    applicationId = "com.xiaoke.nova"
    minSdk = 28
    targetSdk = 35
    versionCode = 1
    versionName = "0.1.0"

    buildConfigField("String", "API_BASE_URL", "\"http://52.77.85.56/\"")
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      proguardFiles(
        getDefaultProguardFile("proguard-android-optimize.txt"),
        "proguard-rules.pro",
      )
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlinOptions {
    jvmTarget = "17"
  }

  buildFeatures {
    compose = true
    buildConfig = true
  }

  composeOptions {
    kotlinCompilerExtensionVersion = libs.versions.composeCompiler.get()
  }

  packaging {
    resources {
      excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
  }
}

dependencies {
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.lifecycle.runtime.ktx)
  implementation(libs.androidx.lifecycle.runtime.compose)
  implementation(libs.androidx.activity.compose)

  implementation(platform(libs.androidx.compose.bom))
  implementation(libs.androidx.compose.ui)
  implementation(libs.androidx.compose.ui.graphics)
  implementation(libs.androidx.compose.ui.tooling.preview)
  implementation(libs.androidx.compose.foundation)
  implementation(libs.androidx.compose.material3)
  implementation(libs.androidx.compose.material.icons)
  implementation(libs.google.material)

  implementation(libs.androidx.room.runtime)
  implementation(libs.androidx.room.ktx)
  ksp(libs.androidx.room.compiler)

  implementation(libs.androidx.work.runtime)

  implementation(libs.retrofit)
  implementation(libs.retrofit.gson)
  implementation(libs.okhttp.logging)
  implementation(libs.gson)

  implementation(libs.media3.exoplayer)
  implementation(libs.media3.session)
  implementation(libs.media3.ui)

  debugImplementation(libs.androidx.compose.ui.tooling)
}
