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

import kotlinx.coroutines.CompletableDeferred
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

class PlaybackManager(
  context: Context,
  private val bookDao: BookDao,
) {
  private val appContext = context.applicationContext
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private val controllerDeferred = CompletableDeferred<MediaController>()
  private val _uiState = MutableStateFlow(PlaybackUiState())
  val uiState: StateFlow<PlaybackUiState> = _uiState.asStateFlow()

  private var currentBook: BookWithChapters? = null
  private var currentCues: List<SubtitleCue> = emptyList()
  private var pendingBook: BookWithChapters? = null
  private var tickerJob: Job? = null
  private var lastPersistedPosition: Long = -1L

  init {
    connect()
  }

  fun prepareBook(book: BookWithChapters) {
    currentBook = book
    if (!controllerDeferred.isCompleted) {
      pendingBook = book
      return
    }

    scope.launch {
      val controller = controllerDeferred.await()
      val (chapterIndex, chapterPositionMs) = locateBookPosition(book)
      val mediaItems = book.chapters.map { chapter ->
        MediaItem.Builder()
          .setMediaId(chapter.id)
          .setUri(Uri.fromFile(File(chapter.audioPath)))
          .setMediaMetadata(
            MediaMetadata.Builder()
              .setTitle(chapter.title)
              .setAlbumTitle(book.book.title)
              .build(),
          )
          .setSubtitleConfigurations(
            listOf(
              MediaItem.SubtitleConfiguration.Builder(Uri.fromFile(File(chapter.subtitlePath)))
                .setMimeType(MimeTypes.TEXT_VTT)
                .setLanguage(book.book.language)
                .build(),
            ),
          )
          .build()
      }

      controller.setMediaItems(mediaItems, chapterIndex, chapterPositionMs)
      controller.prepare()
      controller.playWhenReady = true
      loadSubtitleCues(chapterIndex)
      publishState(controller)
    }
  }

  fun togglePlayPause() {
    scope.launch {
      val controller = controllerDeferred.await()
      if (controller.isPlaying) controller.pause() else controller.play()
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
      loadSubtitleCues(index)
      publishState(controller)
    }
  }

  fun skipToNextChapter() {
    scope.launch {
      val controller = controllerDeferred.await()
      if (controller.hasNextMediaItem()) {
        controller.seekToNextMediaItem()
        loadSubtitleCues(controller.currentMediaItemIndex)
        publishState(controller)
      }
    }
  }

  fun skipToPreviousChapter() {
    scope.launch {
      val controller = controllerDeferred.await()
      if (controller.hasPreviousMediaItem()) {
        controller.seekToPreviousMediaItem()
        loadSubtitleCues(controller.currentMediaItemIndex)
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
      pendingBook = null
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
            pendingBook = null
            prepareBook(it)
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
    currentCues =
      withContext(Dispatchers.IO) {
        SubtitleParser.parse(File(chapter.subtitlePath))
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
        currentChapterIndex = chapterIndex,
        chapterCount = book?.chapters?.size ?: 0,
        positionMs = positionMs,
        durationMs = chapter?.durationMs ?: 0L,
        speed = controller.playbackParameters.speed,
        subtitleText = subtitle,
      )
  }

  private fun persistPositionIfNeeded(controller: Player) {
    val book = currentBook ?: return
    val chapterIndex = controller.currentMediaItemIndex.coerceAtLeast(0)
    val globalPosition =
      book.chapters
        .filter { it.indexInBook < chapterIndex }
        .sumOf { it.durationMs } + controller.currentPosition.coerceAtLeast(0L)

    if (kotlin.math.abs(globalPosition - lastPersistedPosition) < 2_000) {
      return
    }

    lastPersistedPosition = globalPosition
    scope.launch(Dispatchers.IO) {
      bookDao.updateLastPosition(book.book.id, globalPosition)
    }
  }

  private fun locateBookPosition(book: BookWithChapters): Pair<Int, Long> {
    var remaining = book.book.lastPositionMs
    for (chapter in book.chapters) {
      if (remaining <= chapter.durationMs) {
        return chapter.indexInBook to remaining
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
            loadSubtitleCues(player.currentMediaItemIndex.coerceAtLeast(0))
            publishState(player)
          }
        } else {
          publishState(player)
        }
      }
    }
}
