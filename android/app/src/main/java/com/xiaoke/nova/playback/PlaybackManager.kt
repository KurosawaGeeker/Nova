package com.xiaoke.nova.playback

import android.content.ComponentName
import android.content.Context
import android.net.Uri

import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken

import java.io.File

import com.xiaoke.nova.data.local.BookDao
import com.xiaoke.nova.data.local.BookWithChapters
import com.xiaoke.nova.data.local.ChapterEntity
import com.xiaoke.nova.data.local.ScriptSegmentEntity

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class PlaybackUiState(
  val connected: Boolean = false,
  val bookTitle: String = "",
  val chapterTitle: String = "",
  val isPlaying: Boolean = false,
  val currentChapterIndex: Int = 0,
  val chapterCount: Int = 0,
  val positionMs: Long = 0L,
  val durationMs: Long = 0L,
  val speed: Float = 1f,
  val subtitleText: String = "",
)

data class PlaybackResumePoint(
  val chapterIndex: Int,
  val positionMs: Long,
  val wasPlaying: Boolean,
)

data class VoiceCommandPlaybackContext(
  val bookId: String,
  val bookTitle: String,
  val chapterTitle: String,
  val chapterIndex: Int,
  val positionMs: Long,
  val resumePoint: PlaybackResumePoint,
  val currentSegment: ScriptSegmentEntity?,
  val previousSegment: ScriptSegmentEntity?,
  val nextSegments: List<ScriptSegmentEntity>,
)

class PlaybackManager(
  context: Context,
  private val bookDao: BookDao,
) {
  private val appContext = context.applicationContext
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private val controllerDeferred = CompletableDeferred<MediaController>()
  private val _uiState = MutableStateFlow(PlaybackUiState())
  val uiState: StateFlow<PlaybackUiState> = _uiState.asStateFlow()
  private val _voiceCommandRequests = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
  val voiceCommandRequests: SharedFlow<Unit> = _voiceCommandRequests.asSharedFlow()

  private var currentBook: BookWithChapters? = null
  private var currentCues: List<SubtitleCue> = emptyList()
  private var currentSegments: List<ScriptSegmentEntity> = emptyList()
  private var pendingBook: BookWithChapters? = null
  private var pendingStartChapterId: String? = null
  private var tickerJob: Job? = null
  private var lastPersistedPosition: Long = -1L
  private var suppressNextPauseCommand = false
  private var externalPauseVoiceCommand = false

  init {
    connect()
  }

  fun prepareBook(book: BookWithChapters, startChapterId: String? = null) {
    val playableBook = book.copy(chapters = book.chapters.sortedBy { it.indexInBook }.filter { it.isPlayable })
    currentBook = playableBook
    if (!controllerDeferred.isCompleted) {
      pendingBook = book
      pendingStartChapterId = startChapterId
      return
    }

    scope.launch {
      val controller = controllerDeferred.await()
      if (playableBook.chapters.isEmpty()) {
        controller.stop()
        controller.clearMediaItems()
        currentCues = emptyList()
        currentSegments = emptyList()
        _uiState.value =
          PlaybackUiState(
            connected = true,
            bookTitle = book.book.title,
            chapterCount = 0,
            subtitleText = "No ready chapters yet.",
          )
        return@launch
      }

      val (chapterIndex, chapterPositionMs) =
        startChapterId
          ?.let { chapterId -> playableBook.chapters.indexOfFirst { it.id == chapterId } }
          ?.takeIf { it >= 0 }
          ?.let { it to 0L }
          ?: locateBookPosition(playableBook)
      val mediaItems = playableBook.chapters.map { chapter ->
        MediaItem.Builder()
          .setMediaId(chapter.id)
          .setUri(Uri.fromFile(File(chapter.audioPath!!)))
          .setMediaMetadata(
            MediaMetadata.Builder()
              .setTitle(chapter.title)
              .setAlbumTitle(playableBook.book.title)
              .build(),
          )
          .setSubtitleConfigurations(
            listOf(
              MediaItem.SubtitleConfiguration.Builder(Uri.fromFile(File(chapter.subtitlePath!!)))
                .setMimeType(MimeTypes.TEXT_VTT)
                .setLanguage(playableBook.book.language)
                .build(),
            ),
          )
          .build()
      }

      controller.setMediaItems(mediaItems, chapterIndex, chapterPositionMs)
      controller.prepare()
      controller.playWhenReady = true
      loadPlaybackMetadata(chapterIndex)
      publishState(controller)
    }
  }

  fun togglePlayPause() {
    scope.launch {
      val controller = controllerDeferred.await()
      if (controller.isPlaying) {
        suppressNextPauseCommand = true
        controller.pause()
      } else {
        controller.play()
      }
      publishState(controller)
    }
  }

  fun seekBy(deltaMs: Long) {
    scope.launch {
      val controller = controllerDeferred.await()
      controller.seekTo((controller.currentPosition + deltaMs).coerceAtLeast(0L))
      publishState(controller)
    }
  }

  fun seekTo(positionMs: Long) {
    scope.launch {
      val controller = controllerDeferred.await()
      controller.seekTo(positionMs)
      publishState(controller)
    }
  }

  fun seekToChapter(index: Int) {
    scope.launch {
      val controller = controllerDeferred.await()
      controller.seekToDefaultPosition(index)
      loadPlaybackMetadata(index)
      publishState(controller)
    }
  }

  fun seekToChapterId(chapterId: String) {
    scope.launch {
      val controller = controllerDeferred.await()
      val index = currentBook?.chapters?.indexOfFirst { it.id == chapterId } ?: -1
      if (index < 0) {
        return@launch
      }
      controller.seekToDefaultPosition(index)
      loadPlaybackMetadata(index)
      publishState(controller)
    }
  }

  fun skipToNextChapter() {
    scope.launch {
      val controller = controllerDeferred.await()
      if (controller.hasNextMediaItem()) {
        controller.seekToNextMediaItem()
        loadPlaybackMetadata(controller.currentMediaItemIndex)
        publishState(controller)
      }
    }
  }

  fun skipToPreviousChapter() {
    scope.launch {
      val controller = controllerDeferred.await()
      if (controller.hasPreviousMediaItem()) {
        controller.seekToPreviousMediaItem()
        loadPlaybackMetadata(controller.currentMediaItemIndex)
        publishState(controller)
      }
    }
  }

  fun setPlaybackSpeed(speed: Float) {
    scope.launch {
      val controller = controllerDeferred.await()
      controller.setPlaybackSpeed(speed)
      publishState(controller)
    }
  }

  suspend fun pauseForVoiceCommand(): VoiceCommandPlaybackContext? {
    val controller = controllerDeferred.await()
    val book = currentBook ?: return null
    val chapterIndex = controller.currentMediaItemIndex.coerceAtLeast(0)
    val chapter = book.chapters.getOrNull(chapterIndex) ?: return null
    val positionMs = controller.currentPosition.coerceAtLeast(0L)
    val wasPlaying = controller.isPlaying || externalPauseVoiceCommand
    externalPauseVoiceCommand = false

    pauseWithoutVoiceCommand(controller)
    publishState(controller)

    val previousSegment = currentSegments.lastOrNull { it.endMs <= positionMs }
    val currentSegment = currentSegments.firstOrNull { positionMs in it.startMs until it.endMs }
    val nextSegments = currentSegments.filter { it.startMs > positionMs }.take(2)

    return VoiceCommandPlaybackContext(
      bookId = book.book.id,
      bookTitle = book.book.title,
      chapterTitle = chapter.title,
      chapterIndex = chapter.indexInBook,
      positionMs = positionMs,
      resumePoint =
        PlaybackResumePoint(
          chapterIndex = chapterIndex,
          positionMs = positionMs,
          wasPlaying = wasPlaying,
        ),
      currentSegment = currentSegment,
      previousSegment = previousSegment,
      nextSegments = nextSegments,
    )
  }

  fun resumeFrom(point: PlaybackResumePoint) {
    scope.launch {
      val controller = controllerDeferred.await()
      pauseWithoutVoiceCommand(controller)
      controller.seekTo(point.chapterIndex, point.positionMs)
      loadPlaybackMetadata(point.chapterIndex)
      if (point.wasPlaying) {
        controller.play()
      }
      publishState(controller)
    }
  }

  fun replaySegmentThenResume(segment: ScriptSegmentEntity, point: PlaybackResumePoint) {
    scope.launch {
      val controller = controllerDeferred.await()
      val mediaIndex =
        currentBook?.chapters?.indexOfFirst { it.id == segment.chapterId }
          ?.takeIf { it >= 0 }
          ?: segment.chapterIndex
      controller.seekTo(mediaIndex, segment.startMs)
      loadPlaybackMetadata(mediaIndex)
      controller.play()
      publishState(controller)
      while (
        controller.currentMediaItemIndex == mediaIndex &&
          controller.currentPosition < segment.endMs
      ) {
        delay(150)
      }
      resumeFrom(point)
    }
  }

  fun stopIfCurrentBook(bookId: String) {
    if (currentBook?.book?.id != bookId) {
      return
    }

    scope.launch {
      val controller = controllerDeferred.await()
      controller.stop()
      controller.clearMediaItems()
      currentBook = null
      currentCues = emptyList()
      currentSegments = emptyList()
      pendingBook = null
      pendingStartChapterId = null
      lastPersistedPosition = -1L
      _uiState.value = PlaybackUiState(connected = true)
    }
  }

  private fun connect() {
    val token = SessionToken(appContext, ComponentName(appContext, NovaPlaybackService::class.java))
    val future = MediaController.Builder(appContext, token).buildAsync()
    future.addListener(
      {
        try {
          val controller = future.get()
          controller.addListener(playerListener)
          controllerDeferred.complete(controller)
          _uiState.update { it.copy(connected = true) }
          startTicker()
          pendingBook?.let {
            val startChapterId = pendingStartChapterId
            pendingBook = null
            pendingStartChapterId = null
            prepareBook(it, startChapterId)
          }
        } catch (error: Throwable) {
          controllerDeferred.completeExceptionally(error)
        }
      },
      ContextCompat.getMainExecutor(appContext),
    )
  }

  private fun startTicker() {
    if (tickerJob?.isActive == true) {
      return
    }

    tickerJob = scope.launch {
      while (true) {
        if (controllerDeferred.isCompleted && !controllerDeferred.isCancelled) {
          val controller = controllerDeferred.await()
          publishState(controller)
          persistPositionIfNeeded(controller)
        }
        delay(350)
      }
    }
  }

  private suspend fun loadSubtitleCues(chapterIndex: Int) {
    val chapter = currentBook?.chapters?.getOrNull(chapterIndex) ?: return
    val subtitlePath = chapter.subtitlePath ?: return
    currentCues =
      withContext(Dispatchers.IO) {
        SubtitleParser.parse(File(subtitlePath))
      }
  }

  private suspend fun loadPlaybackMetadata(chapterIndex: Int) {
    loadSubtitleCues(chapterIndex)
    val book = currentBook ?: return
    val chapter = book.chapters.getOrNull(chapterIndex) ?: return
    currentSegments =
      withContext(Dispatchers.IO) {
        bookDao.getScriptSegmentsForChapter(book.book.id, chapter.indexInBook)
      }
  }

  private fun publishState(controller: Player) {
    val book = currentBook
    val chapterIndex = controller.currentMediaItemIndex.coerceAtLeast(0)
    val chapter = book?.chapters?.getOrNull(chapterIndex)
    val positionMs = controller.currentPosition.coerceAtLeast(0L)
    val subtitle =
      currentCues.firstOrNull { positionMs in it.startMs until it.endMs }?.text.orEmpty()

    _uiState.value =
      PlaybackUiState(
        connected = true,
        bookTitle = book?.book?.title.orEmpty(),
        chapterTitle = chapter?.title.orEmpty(),
        isPlaying = controller.isPlaying,
        currentChapterIndex = chapter?.indexInBook ?: chapterIndex,
        chapterCount = book?.chapters?.size ?: 0,
        positionMs = positionMs,
        durationMs = chapter?.durationMs ?: 0L,
        speed = controller.playbackParameters.speed,
        subtitleText = subtitle,
      )
  }

  private fun pauseWithoutVoiceCommand(controller: Player) {
    if (controller.isPlaying) {
      suppressNextPauseCommand = true
      controller.pause()
    } else {
      suppressNextPauseCommand = false
    }
  }

  private fun persistPositionIfNeeded(controller: Player) {
    val book = currentBook ?: return
    val chapterIndex = controller.currentMediaItemIndex.coerceAtLeast(0)
    val chapter = book.chapters.getOrNull(chapterIndex) ?: return
    val chapterPositionMs = controller.currentPosition.coerceAtLeast(0L)
    val globalPosition =
      book.chapters
        .take(chapterIndex)
        .sumOf { it.durationMs } + chapterPositionMs

    if (kotlin.math.abs(globalPosition - lastPersistedPosition) < 2_000) {
      return
    }

    lastPersistedPosition = globalPosition
    scope.launch(Dispatchers.IO) {
      bookDao.updateLastPosition(book.book.id, chapter.indexInBook, globalPosition, System.currentTimeMillis())
      bookDao.updateChapterPlayedPosition(book.book.id, chapter.indexInBook, chapterPositionMs, System.currentTimeMillis())
    }
  }

  private fun locateBookPosition(book: BookWithChapters): Pair<Int, Long> {
    var remaining = book.book.lastPositionMs
    for ((position, chapter) in book.chapters.withIndex()) {
      if (remaining <= chapter.durationMs) {
        return position to remaining
      }
      remaining -= chapter.durationMs
    }
    return 0 to 0L
  }

  private val playerListener =
    object : Player.Listener {
      override fun onEvents(player: Player, events: Player.Events) {
        if (
          events.contains(Player.EVENT_MEDIA_ITEM_TRANSITION) ||
          events.contains(Player.EVENT_POSITION_DISCONTINUITY)
        ) {
          scope.launch {
            loadPlaybackMetadata(player.currentMediaItemIndex.coerceAtLeast(0))
            publishState(player)
          }
        } else {
          publishState(player)
        }
      }

      override fun onIsPlayingChanged(isPlaying: Boolean) {
        if (!isPlaying && currentBook != null) {
          if (suppressNextPauseCommand) {
            suppressNextPauseCommand = false
          } else {
            externalPauseVoiceCommand = true
            _voiceCommandRequests.tryEmit(Unit)
          }
        }
      }
    }
}

private val ChapterEntity.isPlayable: Boolean
  get() = status == "READY" && !audioPath.isNullOrBlank() && !subtitlePath.isNullOrBlank()
