package com.xiaoke.nova.voice

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.util.Base64

import androidx.core.content.ContextCompat

import com.xiaoke.nova.BuildConfig
import com.xiaoke.nova.data.local.ScriptSegmentEntity
import com.xiaoke.nova.data.remote.NovaApi
import com.xiaoke.nova.data.remote.VoiceCommandRequest
import com.xiaoke.nova.data.remote.VoiceCommandSegmentDto
import com.xiaoke.nova.playback.PlaybackManager
import com.xiaoke.nova.playback.PlaybackResumePoint

import java.io.File
import java.io.FileOutputStream
import java.net.URI

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class VoiceCommandUiState(
  val phase: VoiceCommandPhase = VoiceCommandPhase.Idle,
  val transcript: String = "",
  val message: String = "",
)

enum class VoiceCommandPhase {
  Idle,
  Listening,
  Thinking,
  Answering,
  Paused,
  Error,
}

class VoiceCommandManager(
  context: Context,
  private val api: NovaApi,
  private val playbackManager: PlaybackManager,
) {
  private val appContext = context.applicationContext
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private val _uiState = MutableStateFlow(VoiceCommandUiState())
  val uiState: StateFlow<VoiceCommandUiState> = _uiState.asStateFlow()
  private var activeJob: Job? = null
  private var mediaPlayer: MediaPlayer? = null

  fun runVoiceCommand() {
    if (activeJob?.isActive == true) {
      return
    }
    activeJob =
      scope.launch {
        val context = playbackManager.pauseForVoiceCommand()
        if (context == null) {
          publishError("No active audiobook is ready for voice commands.")
          return@launch
        }

        if (!hasRecordPermission()) {
          publishError("Microphone permission is required for voice commands.")
          return@launch
        }

        val audioFile =
          runCatching { recordOneShotCommand() }
            .getOrElse { error ->
              publishError(error.message ?: "Recording failed.")
              return@launch
            }

        _uiState.value = VoiceCommandUiState(phase = VoiceCommandPhase.Thinking, message = "Thinking")
        val response =
          runCatching {
            val audioBase64 =
              withContext(Dispatchers.IO) {
                Base64.encodeToString(audioFile.readBytes(), Base64.NO_WRAP)
              }
            api.submitVoiceCommand(
              VoiceCommandRequest(
                audioBase64 = audioBase64,
                mimeType = "audio/mp4",
                debugTranscript = null,
                bookTitle = context.bookTitle,
                chapterTitle = context.chapterTitle,
                chapterIndex = context.chapterIndex,
                positionMs = context.positionMs,
                currentSegment = context.currentSegment?.toDto(),
                previousSegment = context.previousSegment?.toDto(),
                nextSegments = context.nextSegments.map { it.toDto() },
              ),
            )
          }.getOrElse { error ->
            audioFile.delete()
            publishError(error.message ?: "Voice command request failed.")
            return@launch
          }
        audioFile.delete()

        val transcript = response.transcript.orEmpty()
        _uiState.update { it.copy(transcript = transcript) }

        when (response.intent) {
          "REPLAY_PREVIOUS" -> {
            val segment = response.replaySegment
            if (segment == null) {
              publishPaused(response.errorMessage ?: "No replayable segment was returned.", transcript)
            } else {
              _uiState.value =
                VoiceCommandUiState(
                  phase = VoiceCommandPhase.Answering,
                  transcript = transcript,
                  message = "Replaying previous segment",
                )
              playbackManager.replaySegmentThenResume(segment.toEntity(context.bookId), context.resumePoint)
              clearAfterDelay()
            }
          }

          "ASK_QUESTION" -> {
            val answerUrl = response.answerAudioUrl
            if (answerUrl.isNullOrBlank()) {
              publishError(response.errorMessage ?: "No answer audio was returned.")
            } else {
              playAnswerThenResume(answerUrl, context.resumePoint, transcript)
            }
          }

          "RESUME" -> {
            playbackManager.resumeFrom(context.resumePoint)
            _uiState.value = VoiceCommandUiState()
          }

          "PAUSE", "CANCEL" -> {
            publishPaused(response.errorMessage ?: "Paused.", transcript)
          }

          else -> {
            publishError(response.errorMessage ?: "Unknown voice command response.")
          }
        }
      }
  }

  fun runDebugTextCommand(rawTranscript: String) {
    val command = rawTranscript.trim()
    if (command.isBlank() || activeJob?.isActive == true) {
      return
    }
    activeJob =
      scope.launch {
        val context = playbackManager.pauseForVoiceCommand()
        if (context == null) {
          publishError("No active audiobook is ready for voice commands.")
          return@launch
        }

        _uiState.value =
          VoiceCommandUiState(
            phase = VoiceCommandPhase.Thinking,
            transcript = command,
            message = "Thinking",
          )
        val response =
          runCatching {
            api.submitVoiceCommand(
              VoiceCommandRequest(
                audioBase64 = null,
                mimeType = null,
                debugTranscript = command,
                bookTitle = context.bookTitle,
                chapterTitle = context.chapterTitle,
                chapterIndex = context.chapterIndex,
                positionMs = context.positionMs,
                currentSegment = context.currentSegment?.toDto(),
                previousSegment = context.previousSegment?.toDto(),
                nextSegments = context.nextSegments.map { it.toDto() },
              ),
            )
          }.getOrElse { error ->
            publishError(error.message ?: "Voice command request failed.")
            return@launch
          }

        val transcript = response.transcript.orEmpty().ifBlank { command }
        _uiState.update { it.copy(transcript = transcript) }

        when (response.intent) {
          "REPLAY_PREVIOUS" -> {
            val segment = response.replaySegment
            if (segment == null) {
              publishPaused(response.errorMessage ?: "No replayable segment was returned.", transcript)
            } else {
              _uiState.value =
                VoiceCommandUiState(
                  phase = VoiceCommandPhase.Answering,
                  transcript = transcript,
                  message = "Replaying previous segment",
                )
              playbackManager.replaySegmentThenResume(segment.toEntity(context.bookId), context.resumePoint)
              clearAfterDelay()
            }
          }

          "ASK_QUESTION" -> {
            val answerUrl = response.answerAudioUrl
            if (answerUrl.isNullOrBlank()) {
              publishError(response.errorMessage ?: "No answer audio was returned.")
            } else {
              playAnswerThenResume(answerUrl, context.resumePoint, transcript)
            }
          }

          "RESUME" -> {
            playbackManager.resumeFrom(context.resumePoint)
            _uiState.value = VoiceCommandUiState()
          }

          "PAUSE", "CANCEL" -> {
            publishPaused(response.errorMessage ?: "Paused.", transcript)
          }

          else -> {
            publishError(response.errorMessage ?: "Unknown voice command response.")
          }
        }
      }
  }

  fun reportPermissionDenied() {
    _uiState.value =
      VoiceCommandUiState(
        phase = VoiceCommandPhase.Error,
        message = "Microphone permission is required for voice commands.",
      )
    clearAfterDelay()
  }

  private fun hasRecordPermission(): Boolean =
    ContextCompat.checkSelfPermission(appContext, Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED

  private suspend fun recordOneShotCommand(): File =
    withContext(Dispatchers.IO) {
      val outputFile = File(appContext.cacheDir, "voice-command-${System.currentTimeMillis()}.m4a")
      val recorder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          MediaRecorder(appContext)
        } else {
          @Suppress("DEPRECATION")
          MediaRecorder()
        }
      try {
        _uiState.value = VoiceCommandUiState(phase = VoiceCommandPhase.Listening, message = "Listening")
        recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
        recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        recorder.setAudioEncodingBitRate(96_000)
        recorder.setAudioSamplingRate(44_100)
        recorder.setOutputFile(outputFile.absolutePath)
        recorder.prepare()
        recorder.start()
        delay(5_000)
        recorder.stop()
        outputFile
      } finally {
        recorder.release()
      }
    }

  private fun playAnswerThenResume(
    answerUrl: String,
    resumePoint: PlaybackResumePoint,
    transcript: String,
  ) {
    scope.launch {
      _uiState.value =
        VoiceCommandUiState(
          phase = VoiceCommandPhase.Answering,
          transcript = transcript,
          message = "Answering",
        )
      val audioFile =
        runCatching { downloadAnswerAudio(answerUrl) }
          .getOrElse { error ->
            publishError(error.message ?: "Answer audio download failed.")
            return@launch
          }

      mediaPlayer?.release()
      mediaPlayer =
        MediaPlayer().apply {
          setDataSource(appContext, Uri.fromFile(audioFile))
          setOnCompletionListener {
            it.release()
            mediaPlayer = null
            audioFile.delete()
            playbackManager.resumeFrom(resumePoint)
            _uiState.value = VoiceCommandUiState()
          }
          setOnErrorListener { player, _, _ ->
            player.release()
            mediaPlayer = null
            audioFile.delete()
            publishError("Answer playback failed.")
            true
          }
          prepare()
          start()
        }
    }
  }

  private suspend fun downloadAnswerAudio(url: String): File =
    withContext(Dispatchers.IO) {
      val response = api.downloadPackage(normalizeDownloadUrl(url))
      val body = response.body() ?: error("Answer audio response body was empty")
      val outputFile = File(appContext.cacheDir, "voice-answer-${System.currentTimeMillis()}.mp3")
      FileOutputStream(outputFile).use { output ->
        body.byteStream().use { input ->
          input.copyTo(output)
        }
      }
      outputFile
    }

  private fun publishPaused(
    message: String,
    transcript: String = "",
  ) {
    _uiState.value =
      VoiceCommandUiState(
        phase = VoiceCommandPhase.Paused,
        transcript = transcript,
        message = message,
      )
    clearAfterDelay()
  }

  private fun publishError(message: String) {
    _uiState.value = VoiceCommandUiState(phase = VoiceCommandPhase.Error, message = message)
    clearAfterDelay()
  }

  private fun clearAfterDelay() {
    scope.launch {
      delay(2_500)
      _uiState.value = VoiceCommandUiState()
    }
  }

  private fun ScriptSegmentEntity.toDto(): VoiceCommandSegmentDto =
    VoiceCommandSegmentDto(
      id = id,
      chapterId = chapterId,
      chapterIndex = chapterIndex,
      startMs = startMs,
      endMs = endMs,
      title = title,
      text = text,
      kind = kind,
    )

  private fun VoiceCommandSegmentDto.toEntity(bookId: String): ScriptSegmentEntity =
    ScriptSegmentEntity(
      id = id,
      bookId = bookId,
      chapterId = chapterId ?: "$bookId-$chapterIndex",
      chapterIndex = chapterIndex,
      startMs = startMs,
      endMs = endMs,
      title = title,
      text = text,
      kind = kind,
    )
}

private fun normalizeDownloadUrl(rawUrl: String): String {
  val target = URI(rawUrl)
  if (target.host != "localhost" && target.host != "127.0.0.1") {
    return rawUrl
  }

  val backendBase = URI(BuildConfig.API_BASE_URL)
  return URI(
    backendBase.scheme,
    backendBase.userInfo,
    backendBase.host,
    backendBase.port,
    target.path,
    target.query,
    target.fragment,
  ).toString()
}
