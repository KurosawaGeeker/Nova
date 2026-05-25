package com.xiaoke.nova.ui

import android.Manifest
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
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
import androidx.core.content.ContextCompat

import com.xiaoke.nova.NovaContainer
import com.xiaoke.nova.data.local.BookWithChapters
import com.xiaoke.nova.data.local.ChapterEntity
import com.xiaoke.nova.data.local.ImportJobEntity
import com.xiaoke.nova.data.remote.BookDiscoveryResponse
import com.xiaoke.nova.data.remote.DiscoveredChapterResponse
import com.xiaoke.nova.data.remote.FilePreviewChapterResponse
import com.xiaoke.nova.data.remote.FilePreviewResponse
import com.xiaoke.nova.voice.VoiceCommandPhase
import com.xiaoke.nova.voice.VoiceCommandUiState

import kotlinx.coroutines.launch

private val FileImportMimeTypes =
  arrayOf(
    "text/plain",
    "text/markdown",
    "text/html",
    "application/xhtml+xml",
    "application/pdf",
    "application/epub+zip",
    "application/octet-stream",
    "*/*",
  )

private sealed interface Screen {
  data object Library : Screen
  data object Import : Screen
  data class Job(val jobId: String) : Screen
  data class BookDetail(val bookId: String) : Screen
  data class Player(val bookId: String, val startChapterId: String? = null) : Screen
}

@Composable
fun NovaRoot(container: NovaContainer) {
  val books by container.bookRepository.observeBooks().collectAsStateWithLifecycle(initialValue = emptyList())
  val jobs by container.importRepository.observeActiveJobs().collectAsStateWithLifecycle(initialValue = emptyList())
  val finishedJobCount by container.importRepository
    .observeFinishedJobCount()
    .collectAsStateWithLifecycle(initialValue = 0)
  val coroutineScope = rememberCoroutineScope()
  val context = LocalContext.current
  val voiceCommand by container.voiceCommandManager.uiState.collectAsStateWithLifecycle()
  var screen by remember { mutableStateOf<Screen>(Screen.Library) }
  val recordPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      if (granted) {
        container.voiceCommandManager.runVoiceCommand()
      } else {
        container.voiceCommandManager.reportPermissionDenied()
      }
    }

  fun startVoiceCommand() {
    if (
      ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED
    ) {
      container.voiceCommandManager.runVoiceCommand()
    } else {
      recordPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
    }
  }

  fun openBook(bookId: String) {
    val book = books.firstOrNull { it.book.id == bookId }
    screen =
      if (book?.book?.kind == "web_book") {
        Screen.BookDetail(bookId)
      } else {
        Screen.Player(bookId)
      }
  }

  LaunchedEffect(screen, books) {
    val currentScreen = screen
    val currentBookId =
      when (currentScreen) {
        is Screen.BookDetail -> currentScreen.bookId
        is Screen.Player -> currentScreen.bookId
        else -> null
      }
    if (currentBookId != null && books.none { it.book.id == currentBookId }) {
      screen = Screen.Library
    }
  }

  when (val currentScreen = screen) {
    Screen.Library ->
      LibraryScreen(
        books = books,
        jobs = jobs,
        finishedJobCount = finishedJobCount,
        onImportClick = { screen = Screen.Import },
        onOpenJob = { screen = Screen.Job(it) },
        onOpenBook = { openBook(it) },
        onClearFinishedJobs = {
          coroutineScope.launch {
            container.importRepository.clearFinishedJobs()
          }
        },
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
        onDiscover = { url ->
          container.importRepository.discoverBook(url)
        },
        onPreviewFile = { uri ->
          container.importRepository.previewLocalFile(uri)
        },
        onSubmit = { urls ->
          val jobIds = container.importRepository.submitUrls(urls)
          screen =
            when (jobIds.size) {
              0 -> Screen.Library
              1 -> Screen.Job(jobIds.first())
              else -> Screen.Library
            }
        },
        onImportDiscoveredBook = { discovery, chapters ->
          val bookId = container.importRepository.importDiscoveredBook(discovery, chapters)
          screen = Screen.BookDetail(bookId)
        },
      )

    is Screen.Job -> {
      val job by container.importRepository
        .observeJob(currentScreen.jobId)
        .collectAsStateWithLifecycle(initialValue = null)

      JobScreen(
        job = job,
        onBack = { screen = Screen.Library },
        onOpenBook = { bookId -> openBook(bookId) },
      )
    }

    is Screen.BookDetail -> {
      val book by container.bookRepository
        .observeBook(currentScreen.bookId)
        .collectAsStateWithLifecycle(initialValue = null)

      BookDetailScreen(
        book = book,
        onBack = { screen = Screen.Library },
        onPlayBook = { screen = Screen.Player(currentScreen.bookId) },
        onPlayChapter = { chapterId -> screen = Screen.Player(currentScreen.bookId, chapterId) },
      )
    }

    is Screen.Player -> {
      val book by container.bookRepository
        .observeBook(currentScreen.bookId)
        .collectAsStateWithLifecycle(initialValue = null)
      val playback by container.playbackManager.uiState.collectAsStateWithLifecycle()

      LaunchedEffect(book?.book?.id, currentScreen.startChapterId) {
        if (book != null) {
          container.playbackManager.prepareBook(book!!, currentScreen.startChapterId)
        }
      }
      LaunchedEffect(currentScreen.bookId) {
        container.playbackManager.voiceCommandRequests.collect {
          startVoiceCommand()
        }
      }

      PlayerScreen(
        book = book,
        playback = playback,
        voiceCommand = voiceCommand,
        onBack = { screen = Screen.Library },
        onTogglePlay = { container.playbackManager.togglePlayPause() },
        onVoiceCommand = { startVoiceCommand() },
        onDebugVoiceCommand = { container.voiceCommandManager.runDebugTextCommand(it) },
        onSeek = { container.playbackManager.seekTo(it) },
        onSeekBy = { container.playbackManager.seekBy(it) },
        onNextChapter = { container.playbackManager.skipToNextChapter() },
        onPreviousChapter = { container.playbackManager.skipToPreviousChapter() },
        onSelectChapter = { container.playbackManager.seekToChapterId(it) },
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
  finishedJobCount: Int,
  onImportClick: () -> Unit,
  onOpenJob: (String) -> Unit,
  onOpenBook: (String) -> Unit,
  onClearFinishedJobs: () -> Unit,
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
      if (jobs.isNotEmpty() || finishedJobCount > 0) {
        item {
          Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(
              modifier = Modifier.fillMaxWidth(),
              horizontalArrangement = Arrangement.SpaceBetween,
              verticalAlignment = Alignment.CenterVertically,
            ) {
              Text("Active imports", style = androidx.compose.material3.MaterialTheme.typography.titleMedium)
              if (finishedJobCount > 0) {
                TextButton(onClick = onClearFinishedJobs) {
                  Text("Clear finished ($finishedJobCount)")
                }
              }
            }
            if (jobs.isEmpty()) {
              Card {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                  Text("No active imports")
                  if (finishedJobCount > 0) {
                    Text("Completed and failed imports are hidden from this list.")
                  }
                }
              }
            } else {
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
                  val readyText =
                    if (book.book.kind == "web_book") {
                      "${book.book.readyChapterCount}/${book.book.chapterCount} ready"
                    } else {
                      "${book.chapters.size} chapters"
                    }
                  Text("$readyText · ${book.book.status} · ${formatDuration(book.book.durationMs)}")
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
  onDiscover: suspend (String) -> BookDiscoveryResponse,
  onPreviewFile: suspend (Uri) -> FilePreviewResponse,
  onSubmit: suspend (List<String>) -> Unit,
  onImportDiscoveredBook: suspend (BookDiscoveryResponse, List<DiscoveredChapterResponse>) -> Unit,
) {
  val context = LocalContext.current
  val coroutineScope = rememberCoroutineScope()
  var rawInput by rememberSaveable { mutableStateOf("") }
  var submitting by remember { mutableStateOf(false) }
  var discovering by remember { mutableStateOf(false) }
  var submitError by remember { mutableStateOf<String?>(null) }
  var discoveryError by remember { mutableStateOf<String?>(null) }
  var discoveryResult by remember { mutableStateOf<BookDiscoveryResponse?>(null) }
  var filePreviewing by remember { mutableStateOf(false) }
  var filePreviewError by remember { mutableStateOf<String?>(null) }
  var filePreviewResult by remember { mutableStateOf<FilePreviewResponse?>(null) }
  val parsedUrls = remember(rawInput) { parseImportedUrls(rawInput) }
  val singleUrl = parsedUrls.singleOrNull()
  val filePickerLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
      if (uri != null) {
        filePreviewing = true
        filePreviewError = null
        submitError = null
        discoveryError = null
        discoveryResult = null
        coroutineScope.launch {
          runCatching { onPreviewFile(uri) }
            .onSuccess { preview ->
              filePreviewResult = preview
            }
            .onFailure { error ->
              filePreviewError = error.message ?: "File preview failed"
            }
          filePreviewing = false
        }
      }
    }

  filePreviewResult?.let { preview ->
    FilePreviewScreen(
      preview = preview,
      onBack = { filePreviewResult = null },
    )
    return
  }

  discoveryResult?.let { discovery ->
    DiscoveryPreviewScreen(
      discovery = discovery,
      submitting = submitting,
      submitError = submitError,
      onBack = { discoveryResult = null },
      onImportSelected = { chapters ->
        if (submitting) {
          return@DiscoveryPreviewScreen
        }
        submitting = true
        submitError = null
        coroutineScope.launch {
          runCatching { onImportDiscoveredBook(discovery, chapters) }
            .onFailure { error ->
              submitError = error.message ?: "Import submission failed"
            }
          submitting = false
        }
      },
      onImportCurrentPage = {
        if (submitting) {
          return@DiscoveryPreviewScreen
        }
        submitting = true
        submitError = null
        coroutineScope.launch {
          runCatching { onSubmit(listOf(discovery.sourceUrl)) }
            .onFailure { error ->
              submitError = error.message ?: "Import submission failed"
            }
          submitting = false
        }
      },
    )
    return
  }

  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("Import") },
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
      Text("Choose a local TXT, Markdown, HTML, EPUB, or PDF file to preview chapters. This does not start audio generation.")
      Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(
          enabled = !submitting && !discovering && !filePreviewing,
          onClick = { filePickerLauncher.launch(FileImportMimeTypes) },
        ) {
          if (filePreviewing) {
            CircularProgressIndicator(
              modifier = Modifier.height(18.dp),
              strokeWidth = 2.dp,
            )
          } else {
            Icon(Icons.Outlined.Download, contentDescription = null)
          }
          Spacer(modifier = Modifier.padding(4.dp))
          Text(if (filePreviewing) "Previewing..." else "Choose file")
        }
        Text("Preview only", color = Color(0xFF5B6170))
      }
      if (!filePreviewError.isNullOrBlank()) {
        Surface(
          modifier = Modifier.fillMaxWidth(),
          shape = RoundedCornerShape(16.dp),
          color = Color(0xFFFFE1DC),
        ) {
          Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("File preview failed", fontWeight = FontWeight.SemiBold)
            Text(filePreviewError ?: "")
          }
        }
      }
      HorizontalDivider()
      Text("URL import", style = androidx.compose.material3.MaterialTheme.typography.titleMedium)
      Text("Paste one public URL to discover a book, or paste multiple URLs to submit article imports in bulk.")
      Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedButton(
          enabled = !submitting && !discovering && !filePreviewing,
          onClick = {
            val clipboardManager =
              context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clipboardText = clipboardManager.primaryClip?.getItemAt(0)?.coerceToText(context)
            if (!clipboardText.isNullOrBlank()) {
              rawInput = clipboardText.toString()
              submitError = null
              discoveryError = null
              filePreviewError = null
            }
          },
        ) {
          Text("Paste clipboard")
        }
        if (rawInput.isNotBlank()) {
          OutlinedButton(
            enabled = !submitting && !discovering && !filePreviewing,
            onClick = {
              rawInput = ""
              submitError = null
              discoveryError = null
              filePreviewError = null
            },
          ) {
            Text("Clear")
          }
        }
      }
      OutlinedTextField(
        modifier = Modifier.fillMaxWidth(),
        value = rawInput,
        onValueChange = {
          rawInput = it
          submitError = null
          discoveryError = null
          filePreviewError = null
        },
        label = { Text("URLs or clipboard text") },
        enabled = !submitting && !discovering && !filePreviewing,
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
      if (!submitError.isNullOrBlank()) {
        Text(submitError ?: "", color = Color(0xFF8B1E1E))
      }
      if (!discoveryError.isNullOrBlank()) {
        Surface(
          modifier = Modifier.fillMaxWidth(),
          shape = RoundedCornerShape(16.dp),
          color = Color(0xFFFFE1DC),
        ) {
          Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Discovery failed", fontWeight = FontWeight.SemiBold)
            Text(discoveryError ?: "")
            Text("You can still submit the URL as a single article import.")
          }
        }
      }
      Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        if (singleUrl != null) {
          OutlinedButton(
            enabled = !submitting && !discovering && !filePreviewing,
            onClick = {
              if (discovering) {
                return@OutlinedButton
              }
              discovering = true
              submitError = null
              discoveryError = null
              filePreviewError = null
              filePreviewResult = null
              coroutineScope.launch {
                runCatching { onDiscover(singleUrl) }
                  .onSuccess { discovery ->
                    discoveryResult = discovery
                  }
                  .onFailure { error ->
                    discoveryError = error.message ?: "Book discovery failed"
                  }
                discovering = false
              }
            },
          ) {
            if (discovering) {
              CircularProgressIndicator(
                modifier = Modifier.height(18.dp),
                strokeWidth = 2.dp,
              )
            } else {
              Icon(Icons.Outlined.Book, contentDescription = null)
            }
            Spacer(modifier = Modifier.padding(4.dp))
            Text(if (discovering) "Discovering..." else "Discover book")
          }
        }
        Button(
          enabled = parsedUrls.isNotEmpty() && !submitting && !discovering && !filePreviewing,
          onClick = {
            if (submitting) {
              return@Button
            }
            submitting = true
            submitError = null
            filePreviewError = null
            coroutineScope.launch {
              runCatching { onSubmit(parsedUrls) }
                .onFailure { error ->
                  submitError = error.message ?: "Import submission failed"
                }
              submitting = false
            }
          },
        ) {
          if (submitting) {
            CircularProgressIndicator(
              modifier = Modifier.height(18.dp),
              strokeWidth = 2.dp,
            )
          } else {
            Icon(Icons.Outlined.Download, contentDescription = null)
          }
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
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DiscoveryPreviewScreen(
  discovery: BookDiscoveryResponse,
  submitting: Boolean,
  submitError: String?,
  onBack: () -> Unit,
  onImportSelected: (List<DiscoveredChapterResponse>) -> Unit,
  onImportCurrentPage: () -> Unit,
) {
  var selectedChapterIndexes by remember(discovery.discoveryId) {
    mutableStateOf(
      discovery.chapters
        .filter { it.selectedByDefault }
        .map { it.index }
        .toSet(),
    )
  }
  val selectedChapters = discovery.chapters.filter { it.index in selectedChapterIndexes }
  val selectedCount = selectedChapters.size

  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("Discovery preview") },
        navigationIcon = {
          IconButton(onClick = onBack) {
            Icon(Icons.Outlined.ArrowBack, contentDescription = null)
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
      contentPadding = PaddingValues(20.dp),
      verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
      item {
        ElevatedCard {
          Column(modifier = Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(discovery.candidateBookTitle, fontWeight = FontWeight.SemiBold)
            Text("Confidence ${formatConfidence(discovery.confidence)} · ${discovery.discoveryMode}")
            Text("${discovery.chapters.size} chapters detected · $selectedCount selected")
            Text(discovery.sourceUrl, color = Color(0xFF5B6170))
          }
        }
      }
      if (discovery.warnings.isNotEmpty()) {
        item {
          Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp),
            color = Color(0xFFFFF0CC),
          ) {
            Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
              Text("Warnings", fontWeight = FontWeight.SemiBold)
              discovery.warnings.forEach { warning ->
                Text(warning)
              }
            }
          }
        }
      }
      item {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
          OutlinedButton(
            enabled = !submitting && discovery.chapters.isNotEmpty(),
            onClick = {
              selectedChapterIndexes = discovery.chapters.map { it.index }.toSet()
            },
          ) {
            Text("Select all")
          }
          OutlinedButton(
            enabled = !submitting && discovery.chapters.isNotEmpty(),
            onClick = {
              val allIndexes = discovery.chapters.map { it.index }.toSet()
              selectedChapterIndexes = allIndexes - selectedChapterIndexes
            },
          ) {
            Text("Invert")
          }
        }
      }
      items(discovery.chapters, key = { "${it.index}:${it.url}" }) { chapter ->
        ChapterChecklistRow(
          chapter = chapter,
          checked = chapter.index in selectedChapterIndexes,
          enabled = !submitting,
          onCheckedChange = { checked ->
            selectedChapterIndexes =
              if (checked) {
                selectedChapterIndexes + chapter.index
              } else {
                selectedChapterIndexes - chapter.index
              }
          },
        )
      }
      item {
        if (!submitError.isNullOrBlank()) {
          Text(submitError ?: "", color = Color(0xFF8B1E1E))
        }
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
          Button(
            enabled = selectedCount > 0 && !submitting,
            onClick = { onImportSelected(selectedChapters) },
          ) {
            if (submitting) {
              CircularProgressIndicator(
                modifier = Modifier.height(18.dp),
                strokeWidth = 2.dp,
              )
            } else {
              Icon(Icons.Outlined.Download, contentDescription = null)
            }
            Spacer(modifier = Modifier.padding(4.dp))
            Text(
              if (submitting) {
                "Submitting..."
              } else {
                "Import selected ($selectedCount)"
              },
            )
          }
          OutlinedButton(enabled = !submitting, onClick = onImportCurrentPage) {
            Text("Import current page only")
          }
        }
      }
    }
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FilePreviewScreen(
  preview: FilePreviewResponse,
  onBack: () -> Unit,
) {
  val isReady = preview.status == "READY"
  var selectedChapterIds by remember(preview.fileName, preview.status, preview.chapters.size) {
    mutableStateOf(
      if (isReady) {
        preview.chapters.map { it.id }.toSet()
      } else {
        emptySet<String>()
      },
    )
  }
  val selectedCount = preview.chapters.count { it.id in selectedChapterIds }

  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("File preview") },
        navigationIcon = {
          IconButton(onClick = onBack) {
            Icon(Icons.Outlined.ArrowBack, contentDescription = null)
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
      contentPadding = PaddingValues(20.dp),
      verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
      item {
        ElevatedCard {
          Column(modifier = Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(preview.detectedTitle?.takeIf { it.isNotBlank() } ?: preview.fileName, fontWeight = FontWeight.SemiBold)
            Text("${preview.fileType.uppercase()} · ${preview.status} · Confidence ${formatConfidence(preview.confidence)}")
            Text("Chaptering ${preview.chapteringMode} · Language ${preview.language}")
            Text("${preview.chapters.size} chapters detected · $selectedCount selected")
            Text(preview.fileName, color = Color(0xFF5B6170))
          }
        }
      }

      if (!isReady) {
        item {
          Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp),
            color = filePreviewStatusColor(preview.status),
          ) {
            Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
              Text(filePreviewStatusTitle(preview.status), fontWeight = FontWeight.SemiBold)
              Text(filePreviewStatusMessage(preview))
            }
          }
        }
      }

      if (preview.warnings.isNotEmpty()) {
        item {
          Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp),
            color = Color(0xFFFFF0CC),
          ) {
            Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
              Text("Warnings", fontWeight = FontWeight.SemiBold)
              preview.warnings.forEach { warning ->
                Text(warning)
              }
            }
          }
        }
      }

      if (isReady) {
        item {
          Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedButton(
              enabled = preview.chapters.isNotEmpty(),
              onClick = { selectedChapterIds = preview.chapters.map { it.id }.toSet() },
            ) {
              Text("Select all")
            }
            OutlinedButton(
              enabled = preview.chapters.isNotEmpty(),
              onClick = {
                val allIds = preview.chapters.map { it.id }.toSet()
                selectedChapterIds = allIds - selectedChapterIds
              },
            ) {
              Text("Invert")
            }
          }
        }
      }

      if (preview.chapters.isEmpty()) {
        item {
          Card {
            Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
              Text("No chapters available", fontWeight = FontWeight.SemiBold)
              Text("The backend did not return selectable chapter boundaries for this file.")
            }
          }
        }
      } else {
        items(preview.chapters, key = { it.id }) { chapter ->
          FilePreviewChapterChecklistRow(
            chapter = chapter,
            checked = chapter.id in selectedChapterIds,
            enabled = isReady,
            onCheckedChange = { checked ->
              selectedChapterIds =
                if (checked) {
                  selectedChapterIds + chapter.id
                } else {
                  selectedChapterIds - chapter.id
                }
            },
          )
        }
      }

      item {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
          Button(enabled = false, onClick = {}) {
            Icon(Icons.Outlined.Download, contentDescription = null)
            Spacer(modifier = Modifier.padding(4.dp))
            Text(
              if (isReady) {
                "Generate audio in next phase ($selectedCount)"
              } else {
                "Audio import unavailable"
              },
            )
          }
          Text(
            "Preview-only phase: no file audio generation, PDF OCR, or EPUB/PDF audio import is started from this screen.",
            color = Color(0xFF5B6170),
          )
        }
      }
    }
  }
}

@Composable
private fun FilePreviewChapterChecklistRow(
  chapter: FilePreviewChapterResponse,
  checked: Boolean,
  enabled: Boolean,
  onCheckedChange: (Boolean) -> Unit,
) {
  Card {
    Row(
      modifier =
        Modifier
          .fillMaxWidth()
          .padding(14.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Checkbox(
        checked = checked,
        enabled = enabled,
        onCheckedChange = onCheckedChange,
      )
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Text(chapter.title.ifBlank { chapter.id }, fontWeight = FontWeight.SemiBold)
        Text(
          "${chapter.characterCount} chars · ${formatEstimatedMinutes(chapter.estimatedMinutes)}",
          color = Color(0xFF5B6170),
        )
        if (chapter.previewText.isNotBlank()) {
          Text(chapter.previewText, color = Color(0xFF5B6170))
        }
      }
    }
  }
}

@Composable
private fun ChapterChecklistRow(
  chapter: DiscoveredChapterResponse,
  checked: Boolean,
  enabled: Boolean,
  onCheckedChange: (Boolean) -> Unit,
) {
  Card {
    Row(
      modifier =
        Modifier
          .fillMaxWidth()
          .padding(14.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Checkbox(
        checked = checked,
        enabled = enabled,
        onCheckedChange = onCheckedChange,
      )
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("${chapter.index + 1}. ${chapter.title}", fontWeight = FontWeight.SemiBold)
        Text(chapter.url, color = Color(0xFF5B6170))
        Text("Confidence ${formatConfidence(chapter.confidence)}", color = Color(0xFF5B6170))
      }
    }
  }
}

private fun formatConfidence(confidence: Double): String =
  "${(confidence.coerceIn(0.0, 1.0) * 100).toInt()}%"

private fun formatEstimatedMinutes(minutes: Int): String =
  if (minutes <= 0) {
    "<1 min"
  } else {
    "$minutes min"
  }

private fun filePreviewStatusTitle(status: String): String =
  when (status) {
    "OCR_REQUIRED" -> "OCR required"
    "UNSUPPORTED" -> "Unsupported file"
    "EMPTY" -> "No readable text"
    else -> "Preview not ready"
  }

private fun filePreviewStatusMessage(preview: FilePreviewResponse): String =
  when (preview.status) {
    "OCR_REQUIRED" -> "This looks like a scanned or image-only PDF. OCR is intentionally not implemented in V1."
    "UNSUPPORTED" -> "This file type or document structure cannot be previewed by the current backend."
    "EMPTY" -> "The backend did not find readable text in this file."
    else -> "The backend returned ${preview.status}; no audio action is available for this file."
  }

private fun filePreviewStatusColor(status: String): Color =
  when (status) {
    "OCR_REQUIRED" -> Color(0xFFFFF0CC)
    "UNSUPPORTED" -> Color(0xFFFFE1DC)
    "EMPTY" -> Color(0xFFFFE1DC)
    else -> Color(0xFFE8EAEE)
  }

private val ChapterEntity.isPlayable: Boolean
  get() = status == "READY" && !audioPath.isNullOrBlank() && !subtitlePath.isNullOrBlank()

private val ChapterEntity.statusLabel: String
  get() {
    val retryText =
      when {
        retryCount <= 0 -> ""
        nextRetryAt != null -> " · retry scheduled $retryCount/$maxRetries"
        retryCount < maxRetries -> " · retrying $retryCount/$maxRetries"
        else -> " · retries $retryCount/$maxRetries"
      }
    val progressText = if (status == "READY") "" else " · ${progress.coerceIn(0, 100)}%"
    return status + progressText + retryText
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BookDetailScreen(
  book: BookWithChapters?,
  onBack: () -> Unit,
  onPlayBook: () -> Unit,
  onPlayChapter: (String) -> Unit,
) {
  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text(book?.book?.title ?: "Book") },
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

    val chapters = book.chapters.sortedBy { it.indexInBook }
    val readyChapters = chapters.filter { it.isPlayable }

    LazyColumn(
      modifier =
        Modifier
          .fillMaxSize()
          .padding(paddingValues),
      contentPadding = PaddingValues(20.dp),
      verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
      item {
        ElevatedCard {
          Column(modifier = Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(book.book.title, fontWeight = FontWeight.SemiBold)
            val summary =
              "${book.book.status} · ${book.book.readyChapterCount}/${book.book.chapterCount} ready" +
                (if (book.book.failedChapterCount > 0) " · ${book.book.failedChapterCount} failed" else "")
            Text(summary)
            Text(book.book.sourceRootUrl, color = Color(0xFF5B6170))
            Button(enabled = readyChapters.isNotEmpty(), onClick = onPlayBook) {
              Icon(Icons.Outlined.PlayArrow, contentDescription = null)
              Spacer(modifier = Modifier.padding(4.dp))
              Text(if (readyChapters.isEmpty()) "Waiting for first ready chapter" else "Play ready chapters")
            }
          }
        }
      }

      item {
        Text("Chapters", style = androidx.compose.material3.MaterialTheme.typography.titleMedium)
      }

      items(chapters, key = { it.id }) { chapter ->
        ChapterStatusCard(
          chapter = chapter,
          onPlay = { onPlayChapter(chapter.id) },
        )
      }
    }
  }
}

@Composable
private fun ChapterStatusCard(
  chapter: ChapterEntity,
  onPlay: () -> Unit,
) {
  ElevatedCard {
    Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
          Text("${chapter.indexInBook + 1}. ${chapter.title}", fontWeight = FontWeight.SemiBold)
          Text(chapter.sourceUrl, color = Color(0xFF5B6170))
        }
        if (chapter.isPlayable) {
          Button(onClick = onPlay) {
            Text("Play")
          }
        }
      }
      Text(chapter.statusLabel, color = Color(0xFF5B6170))
      if (chapter.status != "READY") {
        LinearProgressIndicator(
          progress = { chapter.progress.coerceIn(0, 100) / 100f },
          modifier = Modifier.fillMaxWidth(),
        )
      } else {
        Text(formatDuration(chapter.durationMs), color = Color(0xFF5B6170))
      }
      if (!chapter.errorMessage.isNullOrBlank()) {
        Text(chapter.errorMessage ?: "", color = Color(0xFF8B1E1E))
      }
    }
  }
}

@Composable
private fun ChapterPlaybackRow(
  chapter: ChapterEntity,
  actionLabel: String,
) {
  Row(
    modifier = Modifier.fillMaxWidth().padding(16.dp),
    horizontalArrangement = Arrangement.SpaceBetween,
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
      Text("${chapter.indexInBook + 1}. ${chapter.title}", fontWeight = FontWeight.SemiBold)
      Text(
        if (chapter.isPlayable) {
          formatDuration(chapter.durationMs)
        } else {
          chapter.statusLabel
        },
        color = Color(0xFF5B6170),
      )
    }
    Text(actionLabel, color = Color(0xFF5B6170))
  }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun PlayerScreen(
  book: BookWithChapters?,
  playback: com.xiaoke.nova.playback.PlaybackUiState,
  voiceCommand: VoiceCommandUiState,
  onBack: () -> Unit,
  onTogglePlay: () -> Unit,
  onVoiceCommand: () -> Unit,
  onDebugVoiceCommand: (String) -> Unit,
  onSeek: (Long) -> Unit,
  onSeekBy: (Long) -> Unit,
  onNextChapter: () -> Unit,
  onPreviousChapter: () -> Unit,
  onSelectChapter: (String) -> Unit,
  onSetSpeed: (Float) -> Unit,
) {
  var debugCommand by rememberSaveable { mutableStateOf("上一段我没听懂，重播一下") }

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
            Text("Chapter ${playback.currentChapterIndex + 1} · ${playback.chapterCount} ready")
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
              horizontalArrangement = Arrangement.Center,
            ) {
              OutlinedButton(
                enabled = voiceCommand.phase == VoiceCommandPhase.Idle || voiceCommand.phase == VoiceCommandPhase.Error,
                onClick = onVoiceCommand,
              ) {
                Text("Voice command")
              }
            }
            OutlinedTextField(
              modifier = Modifier.fillMaxWidth(),
              value = debugCommand,
              onValueChange = { debugCommand = it },
              label = { Text("Debug text command") },
              singleLine = true,
            )
            OutlinedButton(
              enabled =
                debugCommand.isNotBlank() &&
                  (voiceCommand.phase == VoiceCommandPhase.Idle || voiceCommand.phase == VoiceCommandPhase.Error),
              onClick = { onDebugVoiceCommand(debugCommand) },
            ) {
              Text("Run debug command")
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

      if (voiceCommand.phase != VoiceCommandPhase.Idle) {
        item {
          Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(20.dp),
            color =
              if (voiceCommand.phase == VoiceCommandPhase.Error) {
                Color(0xFFFFE1DC)
              } else {
                Color(0xFFE5F2EA)
              },
          ) {
            Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
              Text(
                when (voiceCommand.phase) {
                  VoiceCommandPhase.Listening -> "Listening"
                  VoiceCommandPhase.Thinking -> "Thinking"
                  VoiceCommandPhase.Answering -> "Answering"
                  VoiceCommandPhase.Paused -> "Paused"
                  VoiceCommandPhase.Error -> "Voice command failed"
                  VoiceCommandPhase.Idle -> ""
                },
                fontWeight = FontWeight.SemiBold,
              )
              if (voiceCommand.message.isNotBlank()) {
                Text(voiceCommand.message)
              }
              if (voiceCommand.transcript.isNotBlank()) {
                Text("You said: ${voiceCommand.transcript}", color = Color(0xFF3F5E4A))
              }
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
          book.chapters.sortedBy { it.indexInBook }.forEach { chapter ->
            val ready = chapter.isPlayable
            val content: @Composable () -> Unit = {
              ChapterPlaybackRow(
                chapter = chapter,
                actionLabel = if (ready) "Play" else chapter.status,
              )
            }
            if (ready) {
              Card(onClick = { onSelectChapter(chapter.id) }) {
                content()
              }
            } else {
              Card {
                content()
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
