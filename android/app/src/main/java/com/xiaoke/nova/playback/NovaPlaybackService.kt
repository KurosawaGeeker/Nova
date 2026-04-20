package com.xiaoke.nova.playback

import androidx.media3.common.AudioAttributes
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

class NovaPlaybackService : MediaSessionService() {
  private var mediaSession: MediaSession? = null

  override fun onCreate() {
    super.onCreate()
    val player =
      ExoPlayer.Builder(this)
        .build()
        .apply {
          setAudioAttributes(
            AudioAttributes.Builder()
              .setContentType(androidx.media3.common.C.AUDIO_CONTENT_TYPE_SPEECH)
              .setUsage(androidx.media3.common.C.USAGE_MEDIA)
              .build(),
            true,
          )
          setHandleAudioBecomingNoisy(true)
        }

    mediaSession = MediaSession.Builder(this, player).build()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? =
    mediaSession

  override fun onDestroy() {
    mediaSession?.run {
      player.release()
      release()
    }
    mediaSession = null
    super.onDestroy()
  }
}
