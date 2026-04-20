package com.xiaoke.nova

import android.app.Application
import android.content.Context

import com.xiaoke.nova.work.NotificationHelper

class NovaApp : Application() {
  lateinit var container: NovaContainer
    private set

  override fun onCreate() {
    super.onCreate()
    NotificationHelper.ensureChannels(this)
    container = NovaContainer(this)
  }
}

val Context.novaApp: NovaApp
  get() = applicationContext as NovaApp
