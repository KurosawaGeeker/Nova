package com.xiaoke.nova.ui

import android.content.ClipboardManager
import android.content.Context

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Book
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.QueueMusic
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Divider
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.ui.platform.LocalContext

import com.xiaoke.nova.NovaContainer
import com.xiaoke.nova.data.local.BookWithChapters
import com.xiaoke.nova.data.local.ImportJobEntity

import kotlinx.coroutines.launch

private sealed interface Screen {
  data object Library : Screen
  data object Import : Screen
  data class Job(val jobId: String) : Screen
  data class Player(val bookId: String) : Screen
}

@Composable
fun NovaRoot(container: NovaContainer) {
  val books by container.bookRepository.observeBooks().collectAsStateWithLifecycle(initialValue = emptyList())
  val jobs by container.importRepository.observeJobs().collectAsStateWithLifecycle(initialValue = emptyList())
  val coroutineScope = rememberCoroutineScope()
  var screen by remember { mutableStateOf<Screen>(Screen.Library) }

  LaunchedEffect(screen, books) {
    val currentScreen = screen
    if (currentScreen is Screen.Player && books.none { it.book.id == currentScreen.bookId }) {
      screen = Screen.Library
    }
  }

  when (val currentScreen = screen) {
    Screen.Library ->
      LibraryScreen(
        books = books,
        jobs = jobs,
        onImportClick = { screen = Screen.Import },
        onOpenJob = { screen = Screen.Job(it) },
        onOpenBook = { screen = Screen.Player(it) },
        onDeleteBook = { bookId ->
          coroutineScope.launch {
            container.playbackManager.stopIfCurrentBook(bookId)
            container.bookRepository.deleteBook(bookId)
          }
        },
      )

    Screen.Import ->
      ImportScreen(
        onBack = { screen = Screen.Library },
        onSubmit = { urls ->
          coroutineScope.launch {
            val jobIds = container.importRepository.submitUrls(urls)
            screen =
              when (jobIds.size) {
                0 -> Screen.Library
                1 -> Screen.Job(jobIds.first())
                else -> Screen.Library
              }
          }
        },
      )

    is Screen.Job -> {
      val job by container.importRepository
        .observeJob(currentScreen.jobId)
        .collectAsStateWithLifecycle(initialValue = null)

      JobScreen(
        job = job,
        onBack = { screen = Screen.Library },
        onOpenBook = { bookId -> screen = Screen.Player(bookId) },
      )
    }

    is Screen.Player -> {
      val book by container.bookRepository
        .observeBook(currentScreen.bookId)
        .collectAsStateWithLifecycle(initialValue = null)
      val playback by container.playbackManager.uiState.collectAsStateWithLifecycle()

      LaunchedEffect(book?.book?.id) {
        if (book != null) {
          container.playbackManager.prepareBook(book!!)
        }
      }

      PlayerScreen(
        book = book,
        playback = playback,
        onBack = { screen = Screen.Library },
        onTogglePlay = { container.playbackManager.togglePlayPause() },
        onSeek = { container.playbackManager.seekTo(it) },
        onSeekBy = { container.playbackManager.seekBy(it) },
        onNextChapter = { container.playbackManager.skipToNextChapter() },
        onPreviousChapter = { container.playbackManager.skipToPreviousChapter() },
        onSelectChapter = { container.playbackManager.seekToChapter(it) },
        onSetSpeed = { container.playbackManager.setPlaybackSpeed(it) },
      )
    }
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LibraryScreen(
  books: List<BookWithChapters>,
  jobs: List<ImportJobEntity>,
  onImportClick: () -> Unit,
  onOpenJob: (String) -> Unit,
  onOpenBook: (String) -> Unit,
  onDeleteBook: (String) -> Unit,
) {
  var pendingDeleteBookId by rememberSaveable { mutableStateOf<String?>(null) }
  val pendingDeleteBook = books.firstOrNull { it.book.id == pendingDeleteBookId }

  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("Nova Library") },
        actions = {
          TextButton(onClick = onImportClick) {
            Text("Import URL")
          }
        },
      )
    },
  ) { paddingValues ->
    LazyColumn(
      modifier =
        Modifier
          .fillMaxSize()
          .padding(paddingValues),
      contentPadding = PaddingValues(16.dp),
      verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
      if (jobs.isNotEmpty()) {
        item {
          Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Active imports", style = androidx.compose.material3.MaterialTheme.typography.titleMedium)
            jobs.take(5).forEach { job ->
              ElevatedCard(onClick = { onOpenJob(job.id) }) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                  Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                  ) {
                    Text(job.status, fontWeight = FontWeight.SemiBold)
                    Text("${job.progress}%")
                  }
                  LinearProgressIndicator(progress = { job.progress / 100f }, modifier = Modifier.fillMaxWidth())
                  if (!job.errorMessage.isNullOrBlank()) {
                    Text(job.errorMessage ?: "", color = Color(0xFF8B1E1E))
                  }
                }
              }
            }
          }
        }
      }

      item {
        Text("Bookshelf", style = androidx.compose.material3.MaterialTheme.typography.titleMedium)
      }

      if (books.isEmpty()) {
        item {
          Card {
            Column(modifier = Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
              Text("No books yet")
              Text("Import a public article URL to generate an offline audiobook package.")
              Button(onClick = onImportClick) {
                Icon(Icons.Outlined.Link, contentDescription = null)
                Spacer(modifier = Modifier.padding(4.dp))
                Text("Import URL")
              }
            }
          }
        }
      } else {
        items(books, key = { it.book.id }) { book ->
          ElevatedCard {
            Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
              Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
              ) {
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                  Text(book.book.title, fontWeight = FontWeight.SemiBold)
                  Text("${book.chapters.size} chapters · ${formatDuration(book.book.durationMs)}")
                }
                Icon(Icons.Outlined.PlayArrow, contentDescription = null)
              }
              Text(book.book.sourceUri, color = Color(0xFF5B6170))
              Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
              ) {
                OutlinedButton(onClick = { pendingDeleteBookId = book.book.id }) {
                  Icon(Icons.Outlined.DeleteOutline, contentDescription = null)
                  Spacer(modifier = Modifier.padding(4.dp))
                  Text("Delete")
                }
                Spacer(modifier = Modifier.padding(4.dp))
                Button(onClick = { onOpenBook(book.book.id) }) {
                  Icon(Icons.Outlined.PlayArrow, contentDescription = null)
                  Spacer(modifier = Modifier.padding(4.dp))
                  Text("Open")
                }
              }
            }
          }
        }
      }
    }

    if (pendingDeleteBook != null) {
      AlertDialog(
        onDismissRequest = { pendingDeleteBookId = null },
        title = { Text("Delete audiobook?") },
        text = {
          Text("This will remove the book, subtitles, audio files, and its import record from this device.")
        },
        confirmButton = {
          Button(
            onClick = {
              val bookId = pendingDeleteBook.book.id
              pendingDeleteBookId = null
              onDeleteBook(bookId)
            },
          ) {
            Text("Delete")
          }
        },
        dismissButton = {
          OutlinedButton(onClick = { pendingDeleteBookId = null }) {
            Text("Cancel")
          }
        },
      )
    }
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ImportScreen(
  onBack: () -> Unit,
  onSubmit: suspend (List<String>) -> Unit,
) {
  val context = LocalContext.current
  val coroutineScope = rememberCoroutineScope()
  var rawInput by rememberSaveable { mutableStateOf("") }
  var submitting by remember { mutableStateOf(false) }
  val parsedUrls = remember(rawInput) { parseImportedUrls(rawInput) }

  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("Import article") },
        navigationIcon = {
          IconButton(onClick = onBack) {
            Icon(Icons.Outlined.ArrowBack, contentDescription = null)
          }
        },
      )
    },
  ) { paddingValues ->
    Column(
      modifier =
        Modifier
          .fillMaxSize()
          .padding(paddingValues)
          .padding(20.dp),
      verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
      Text("Paste public article links, or paste a whole clipboard dump that contains multiple URLs. The app will extract and deduplicate them before submitting background jobs.")
      Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedButton(
          onClick = {
            val clipboardManager =
              context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clipboardText = clipboardManager.primaryClip?.getItemAt(0)?.coerceToText(context)
            if (!clipboardText.isNullOrBlank()) {
              rawInput = clipboardText.toString()
            }
          },
        ) {
          Text("Paste clipboard")
        }
        if (rawInput.isNotBlank()) {
          OutlinedButton(onClick = { rawInput = "" }) {
            Text("Clear")
          }
        }
      }
      OutlinedTextField(
        modifier = Modifier.fillMaxWidth(),
        value = rawInput,
        onValueChange = { rawInput = it },
        label = { Text("URLs or clipboard text") },
        singleLine = false,
        minLines = 6,
      )
      Text(
        if (parsedUrls.isEmpty()) {
          "No valid URLs detected yet."
        } else {
          "Detected ${parsedUrls.size} URL${if (parsedUrls.size == 1) "" else "s"}"
        },
      )
      if (parsedUrls.isNotEmpty()) {
        Card {
          Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            parsedUrls.take(8).forEach { parsedUrl ->
              Text(parsedUrl, color = Color(0xFF5B6170))
            }
            if (parsedUrls.size > 8) {
              Text("+${parsedUrls.size - 8} more")
            }
          }
        }
      }
      Button(
        enabled = parsedUrls.isNotEmpty() && !submitting,
        onClick = {
          coroutineScope.launch {
            submitting = true
            runCatching { onSubmit(parsedUrls) }
            submitting = false
          }
        },
      ) {
        Icon(Icons.Outlined.Download, contentDescription = null)
        Spacer(modifier = Modifier.padding(4.dp))
        Text(
          if (submitting) {
            "Submitting..."
          } else {
            "Submit ${parsedUrls.size.coerceAtLeast(1)} import${if (parsedUrls.size == 1) "" else "s"}"
          },
        )
      }
    }
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun JobScreen(
  job: ImportJobEntity?,
  onBack: () -> Unit,
  onOpenBook: (String) -> Unit,
) {
  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("Import status") },
        navigationIcon = {
          IconButton(onClick = onBack) {
            Icon(Icons.Outlined.ArrowBack, contentDescription = null)
          }
        },
      )
    },
  ) { paddingValues ->
    Box(
      modifier =
        Modifier
          .fillMaxSize()
          .padding(paddingValues)
          .padding(20.dp),
    ) {
      if (job == null) {
        CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
      } else {
        Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
          Text(job.normalizedUrl.ifBlank { "Waiting for job metadata..." })
          ElevatedCard {
            Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
              Text(job.status, fontWeight = FontWeight.SemiBold)
              LinearProgressIndicator(progress = { job.progress / 100f }, modifier = Modifier.fillMaxWidth())
              Text("${job.progress}% complete")
              if (!job.errorMessage.isNullOrBlank()) {
                Text(job.errorMessage ?: "", color = Color(0xFF8B1E1E))
              }
            }
          }
          if (job.status == "READY" && !job.bookId.isNullOrBlank()) {
            Button(onClick = { onOpenBook(job.bookId!!) }) {
              Icon(Icons.Outlined.Book, contentDescription = null)
              Spacer(modifier = Modifier.padding(4.dp))
              Text("Open audiobook")
            }
          }
        }
      }
    }
  }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun PlayerScreen(
  book: BookWithChapters?,
  playback: com.xiaoke.nova.playback.PlaybackUiState,
  onBack: () -> Unit,
  onTogglePlay: () -> Unit,
  onSeek: (Long) -> Unit,
  onSeekBy: (Long) -> Unit,
  onNextChapter: () -> Unit,
  onPreviousChapter: () -> Unit,
  onSelectChapter: (Int) -> Unit,
  onSetSpeed: (Float) -> Unit,
) {
  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text(book?.book?.title ?: "Player") },
        navigationIcon = {
          IconButton(onClick = onBack) {
            Icon(Icons.Outlined.ArrowBack, contentDescription = null)
          }
        },
      )
    },
  ) { paddingValues ->
    if (book == null) {
      Box(
        modifier =
          Modifier
            .fillMaxSize()
            .padding(paddingValues),
      ) {
        CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
      }
      return@Scaffold
    }

    LazyColumn(
      modifier =
        Modifier
          .fillMaxSize()
          .padding(paddingValues),
      contentPadding = PaddingValues(20.dp),
      verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
      item {
        ElevatedCard {
          Column(modifier = Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(playback.chapterTitle.ifBlank { "Preparing..." }, fontWeight = FontWeight.SemiBold)
            Text("Chapter ${playback.currentChapterIndex + 1} / ${playback.chapterCount}")
            Slider(
              value = playback.positionMs.toFloat(),
              onValueChange = { onSeek(it.toLong()) },
              valueRange = 0f..(playback.durationMs.coerceAtLeast(1L).toFloat()),
            )
            Row(
              modifier = Modifier.fillMaxWidth(),
              horizontalArrangement = Arrangement.SpaceBetween,
            ) {
              Text(formatDuration(playback.positionMs))
              Text(formatDuration(playback.durationMs))
            }
            Row(
              modifier = Modifier.fillMaxWidth(),
              horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterHorizontally),
              verticalAlignment = Alignment.CenterVertically,
            ) {
              OutlinedButton(onClick = { onSeekBy(-15_000) }) { Text("-15s") }
              Button(onClick = onTogglePlay) { Text(if (playback.isPlaying) "Pause" else "Play") }
              OutlinedButton(onClick = { onSeekBy(15_000) }) { Text("+15s") }
            }
            Row(
              modifier = Modifier.fillMaxWidth(),
              horizontalArrangement = Arrangement.SpaceBetween,
            ) {
              TextButton(onClick = onPreviousChapter) { Text("Previous chapter") }
              TextButton(onClick = onNextChapter) { Text("Next chapter") }
            }
          }
        }
      }

      item {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
          Text("Subtitle", style = androidx.compose.material3.MaterialTheme.typography.titleMedium)
          Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(20.dp),
            color = Color(0xFFF2EEDF),
          ) {
            Text(
              modifier = Modifier.padding(20.dp),
              text = playback.subtitleText.ifBlank { "Waiting for the current sentence..." },
              style = androidx.compose.material3.MaterialTheme.typography.bodyLarge,
            )
          }
        }
      }

      item {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
          Text("Playback speed", style = androidx.compose.material3.MaterialTheme.typography.titleMedium)
          LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(listOf(0.75f, 1f, 1.25f, 1.5f, 2f)) { speed ->
              AssistChip(
                onClick = { onSetSpeed(speed) },
                label = { Text("${speed}x") },
              )
            }
          }
        }
      }

      item {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
          Text("Chapters", style = androidx.compose.material3.MaterialTheme.typography.titleMedium)
          book.chapters.forEach { chapter ->
            Card(onClick = { onSelectChapter(chapter.indexInBook) }) {
              Row(
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
              ) {
                Column(modifier = Modifier.weight(1f)) {
                  Text(chapter.title, fontWeight = FontWeight.SemiBold)
                  Text(formatDuration(chapter.durationMs), color = Color(0xFF5B6170))
                }
                Icon(Icons.Outlined.QueueMusic, contentDescription = null)
              }
            }
            Spacer(modifier = Modifier.height(8.dp))
          }
        }
      }
    }
  }
}

private fun formatDuration(durationMs: Long): String {
  val totalSeconds = (durationMs / 1000).coerceAtLeast(0L)
  val hours = totalSeconds / 3600
  val minutes = (totalSeconds % 3600) / 60
  val seconds = totalSeconds % 60
  return if (hours > 0) {
    "%d:%02d:%02d".format(hours, minutes, seconds)
  } else {
    "%02d:%02d".format(minutes, seconds)
  }
}
