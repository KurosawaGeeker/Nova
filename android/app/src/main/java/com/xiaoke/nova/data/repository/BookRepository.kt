package com.xiaoke.nova.data.repository

import java.io.File

import com.google.gson.annotations.SerializedName
import com.xiaoke.nova.data.local.BookDao
import com.xiaoke.nova.data.local.BookEntity
import com.xiaoke.nova.data.local.BookWithChapters
import com.xiaoke.nova.data.local.ChapterEntity
import com.xiaoke.nova.data.local.ImportJobDao
import com.xiaoke.nova.data.local.ImportJobEntity
import com.xiaoke.nova.data.local.ScriptSegmentEntity
import com.xiaoke.nova.data.remote.BookDiscoveryResponse
import com.xiaoke.nova.data.remote.DiscoveredChapterResponse
import com.xiaoke.nova.data.remote.RemoteBookStatusResponse

import java.time.Instant
import kotlinx.coroutines.flow.Flow

data class PackageManifest(
  @SerializedName("bookId") val bookId: String,
  @SerializedName("title") val title: String,
  @SerializedName("sourceType") val sourceType: String,
  @SerializedName("sourceUrl") val sourceUrl: String,
  @SerializedName("language") val language: String,
  @SerializedName("coverFile") val coverFile: String?,
  @SerializedName("totalDurationMs") val totalDurationMs: Long,
  @SerializedName("scriptFile") val scriptFile: String?,
  @SerializedName("chapters") val chapters: List<PackageChapterManifest>,
)

data class PackageChapterManifest(
  @SerializedName("title") val title: String,
  @SerializedName("durationMs") val durationMs: Long,
  @SerializedName("audioFile") val audioFile: String,
  @SerializedName("subtitleFile") val subtitleFile: String,
)

data class ChapterPackageManifest(
  @SerializedName("bookId") val bookId: String,
  @SerializedName("chapterId") val chapterId: String,
  @SerializedName("index") val index: Int,
  @SerializedName("title") val title: String,
  @SerializedName("sourceUrl") val sourceUrl: String,
  @SerializedName("durationMs") val durationMs: Long,
  @SerializedName("audioFile") val audioFile: String,
  @SerializedName("subtitleFile") val subtitleFile: String,
  @SerializedName("scriptFile") val scriptFile: String?,
)

data class PackageScript(
  @SerializedName("version") val version: Int,
  @SerializedName("bookId") val bookId: String,
  @SerializedName("title") val title: String,
  @SerializedName("segments") val segments: List<PackageScriptSegment>,
)

data class PackageScriptSegment(
  @SerializedName("id") val id: String,
  @SerializedName("chapterIndex") val chapterIndex: Int,
  @SerializedName("startMs") val startMs: Long,
  @SerializedName("endMs") val endMs: Long,
  @SerializedName("title") val title: String?,
  @SerializedName("text") val text: String,
  @SerializedName("kind") val kind: String,
)

data class CreatedDiscoveredBook(
  val bookId: String,
  val chapters: List<ChapterEntity>,
)

class BookRepository(
  private val bookDao: BookDao,
  private val importJobDao: ImportJobDao,
  private val gson: com.google.gson.Gson,
) {
  fun observeBooks(): Flow<List<BookWithChapters>> = bookDao.observeBooks()

  fun observeBook(bookId: String): Flow<BookWithChapters?> = bookDao.observeBook(bookId)

  suspend fun createDiscoveredBook(
    discovery: BookDiscoveryResponse,
    selectedChapters: List<DiscoveredChapterResponse>,
    packageRoot: File,
    bookIdOverride: String? = null,
    chapterIdsByIndex: Map<Int, String> = emptyMap(),
    chapterStatusesByIndex: Map<Int, String> = emptyMap(),
  ): CreatedDiscoveredBook {
    val now = System.currentTimeMillis()
    val bookId = bookIdOverride ?: "local_book_${sanitizeId(discovery.discoveryId)}_$now"
    val sortedChapters = selectedChapters.sortedWith(compareBy({ it.index }, { it.url }))

    packageRoot.mkdirs()
    bookDao.upsertBook(
      BookEntity(
        id = bookId,
        title = discovery.candidateBookTitle.ifBlank { "Discovered book" },
        description = null,
        kind = "web_book",
        sourceType = "web_book",
        sourceUri = discovery.sourceUrl,
        sourceRootUrl = discovery.sourceUrl,
        language = "und",
        status = if (sortedChapters.isEmpty()) "DISCOVERED" else "IMPORTING",
        coverPath = null,
        chapterCount = sortedChapters.size,
        readyChapterCount = 0,
        failedChapterCount = 0,
        durationMs = 0L,
        localPackageDir = packageRoot.absolutePath,
        lastChapterIndex = sortedChapters.firstOrNull()?.index ?: 0,
        lastPositionMs = 0L,
        lastOpenedAt = null,
        createdAt = now,
        updatedAt = now,
      ),
    )

    val chapters =
      sortedChapters.mapIndexed { position, chapter ->
        val chapterId = chapterIdsByIndex[chapter.index] ?: "$bookId-${chapter.index}-$position"
        ChapterEntity(
          id = chapterId,
          bookId = bookId,
          indexInBook = chapter.index,
          title = chapter.title.ifBlank { "Chapter ${chapter.index + 1}" },
          sourceUrl = chapter.url,
          status = chapterStatusesByIndex[chapter.index] ?: "QUEUED",
          progress = 0,
          audioPath = null,
          subtitlePath = null,
          scriptPath = null,
          durationMs = 0L,
          playedPositionMs = 0L,
          retryCount = 0,
          maxRetries = 2,
          nextRetryAt = null,
          errorMessage = null,
          remoteChapterJobId = null,
          createdAt = now,
          updatedAt = now,
          completedAt = null,
        )
      }

    bookDao.upsertChapters(chapters)
    refreshBookProgress(bookId)
    return CreatedDiscoveredBook(bookId, chapters)
  }

  suspend fun applyRemoteBookStatus(remote: RemoteBookStatusResponse) {
    val existingBook = bookDao.getBook(remote.bookId) ?: return
    val now = System.currentTimeMillis()
    bookDao.upsertBook(
      existingBook.copy(
        title = remote.title.ifBlank { existingBook.title },
        status = remote.status,
        chapterCount = remote.chapterCount,
        readyChapterCount = remote.readyChapterCount,
        failedChapterCount = remote.failedChapterCount,
        durationMs = remote.durationMs,
        updatedAt = now,
      ),
    )

    val existingChapters = bookDao.getChaptersForBook(remote.bookId).associateBy { it.id }
    val chapters =
      remote.chapters.map { remoteChapter ->
        val existingChapter = existingChapters[remoteChapter.chapterId]
        val localReady = existingChapter?.hasPlayablePackage == true
        val nextStatus =
          if (localReady && remoteChapter.status != "FAILED") {
            "READY"
          } else {
            remoteChapter.status
          }

        (existingChapter ?: ChapterEntity(
          id = remoteChapter.chapterId,
          bookId = remote.bookId,
          indexInBook = remoteChapter.index,
          title = remoteChapter.title.ifBlank { "Chapter ${remoteChapter.index + 1}" },
          sourceUrl = "",
          status = nextStatus,
          progress = remoteChapter.progress.coerceIn(0, 100),
          audioPath = null,
          subtitlePath = null,
          scriptPath = null,
          durationMs = remoteChapter.durationMs,
          playedPositionMs = 0L,
          retryCount = remoteChapter.retryCount,
          maxRetries = remoteChapter.maxRetries,
          nextRetryAt = parseRemoteTimeMs(remoteChapter.nextRetryAt),
          errorMessage = remoteChapter.errorMessage,
          remoteChapterJobId = null,
          createdAt = now,
          updatedAt = now,
          completedAt = null,
        )).copy(
          title = remoteChapter.title.ifBlank { existingChapter?.title ?: "Chapter ${remoteChapter.index + 1}" },
          status = nextStatus,
          progress = if (nextStatus == "READY") 100 else remoteChapter.progress.coerceIn(0, 100),
          durationMs = remoteChapter.durationMs.takeIf { it > 0L } ?: existingChapter?.durationMs ?: 0L,
          retryCount = remoteChapter.retryCount,
          maxRetries = remoteChapter.maxRetries,
          nextRetryAt = parseRemoteTimeMs(remoteChapter.nextRetryAt),
          errorMessage = remoteChapter.errorMessage,
          updatedAt = now,
          completedAt =
            if (localReady && nextStatus == "READY") {
              existingChapter?.completedAt ?: now
            } else {
              existingChapter?.completedAt
            },
        )
      }
    if (chapters.isNotEmpty()) {
      bookDao.upsertChapters(chapters)
    }
  }

  suspend fun persistPackage(packageDir: File, manifest: PackageManifest) {
    val coverPath = manifest.coverFile?.let { File(packageDir, it).absolutePath }
    val now = System.currentTimeMillis()
    val scriptFile = manifest.scriptFile?.let { File(packageDir, it) }
    val scriptPath = scriptFile?.takeIf { it.exists() }?.absolutePath

    bookDao.upsertBook(
      BookEntity(
        id = manifest.bookId,
        title = manifest.title,
        description = null,
        kind = "single_article",
        sourceType = manifest.sourceType,
        sourceUri = manifest.sourceUrl,
        sourceRootUrl = manifest.sourceUrl,
        language = manifest.language,
        status = "READY",
        coverPath = coverPath,
        chapterCount = manifest.chapters.size,
        readyChapterCount = manifest.chapters.size,
        failedChapterCount = 0,
        durationMs = manifest.totalDurationMs,
        localPackageDir = packageDir.absolutePath,
        lastChapterIndex = 0,
        lastPositionMs = 0L,
        lastOpenedAt = null,
        createdAt = now,
        updatedAt = now,
      ),
    )

    bookDao.deleteChapters(manifest.bookId)
    bookDao.deleteScriptSegments(manifest.bookId)
    val chapters =
      manifest.chapters.mapIndexed { index, chapter ->
        ChapterEntity(
          id = "${manifest.bookId}-$index",
          bookId = manifest.bookId,
          indexInBook = index,
          title = chapter.title,
          sourceUrl = manifest.sourceUrl,
          status = "READY",
          progress = 100,
          audioPath = File(packageDir, chapter.audioFile).absolutePath,
          subtitlePath = File(packageDir, chapter.subtitleFile).absolutePath,
          scriptPath = scriptPath,
          durationMs = chapter.durationMs,
          playedPositionMs = 0L,
          retryCount = 0,
          maxRetries = 2,
          nextRetryAt = null,
          errorMessage = null,
          remoteChapterJobId = null,
          createdAt = now,
          updatedAt = now,
          completedAt = now,
        )
      }
    bookDao.upsertChapters(chapters)

    if (scriptFile?.exists() == true) {
      val script =
        scriptFile.reader().use { reader ->
          gson.fromJson(reader, PackageScript::class.java)
        }
      val chapterIdsByIndex = chapters.associateBy { it.indexInBook }
      bookDao.upsertScriptSegments(
        script.segments.map { segment ->
          ScriptSegmentEntity(
            id = "${manifest.bookId}-${segment.id}",
            bookId = manifest.bookId,
            chapterId = chapterIdsByIndex[segment.chapterIndex]?.id ?: "${manifest.bookId}-${segment.chapterIndex}",
            chapterIndex = segment.chapterIndex,
            startMs = segment.startMs,
            endMs = segment.endMs,
            title = segment.title,
            text = segment.text,
            kind = segment.kind,
          )
        },
      )
    }
  }

  suspend fun persistChapterPackage(
    parentBookId: String,
    chapterId: String,
    packageDir: File,
    manifest: PackageManifest,
    remoteJobId: String,
  ) {
    val existingChapter = bookDao.getChapter(chapterId)
      ?: error("Chapter $chapterId no longer exists")
    val manifestChapter = manifest.chapters.firstOrNull()
      ?: error("Chapter package did not include a playable chapter")
    val now = System.currentTimeMillis()
    val scriptFile = manifest.scriptFile?.let { File(packageDir, it) }
    val scriptPath = scriptFile?.takeIf { it.exists() }?.absolutePath

    bookDao.upsertChapters(
      listOf(
        existingChapter.copy(
          status = "READY",
          progress = 100,
          audioPath = File(packageDir, manifestChapter.audioFile).absolutePath,
          subtitlePath = File(packageDir, manifestChapter.subtitleFile).absolutePath,
          scriptPath = scriptPath,
          durationMs = manifestChapter.durationMs,
          nextRetryAt = null,
          errorMessage = null,
          remoteChapterJobId = remoteJobId,
          updatedAt = now,
          completedAt = now,
        ),
      ),
    )

    bookDao.deleteScriptSegmentsForChapter(chapterId)
    if (scriptFile?.exists() == true) {
      val script =
        scriptFile.reader().use { reader ->
          gson.fromJson(reader, PackageScript::class.java)
        }
      bookDao.upsertScriptSegments(
        script.segments.map { segment ->
          ScriptSegmentEntity(
            id = "$parentBookId-$chapterId-${segment.id}",
            bookId = parentBookId,
            chapterId = chapterId,
            chapterIndex = existingChapter.indexInBook,
            startMs = segment.startMs,
            endMs = segment.endMs,
            title = segment.title,
            text = segment.text,
            kind = segment.kind,
          )
        },
      )
    }

    refreshBookProgress(parentBookId)
  }

  suspend fun persistChapterPackage(
    parentBookId: String,
    chapterId: String,
    packageDir: File,
    manifest: ChapterPackageManifest,
    remoteJobId: String,
  ) {
    val existingChapter = bookDao.getChapter(chapterId)
      ?: error("Chapter $chapterId no longer exists")
    val now = System.currentTimeMillis()
    val scriptFile = manifest.scriptFile?.let { File(packageDir, it) }
    val scriptPath = scriptFile?.takeIf { it.exists() }?.absolutePath

    bookDao.upsertChapters(
      listOf(
        existingChapter.copy(
          title = manifest.title.ifBlank { existingChapter.title },
          sourceUrl = manifest.sourceUrl.ifBlank { existingChapter.sourceUrl },
          status = "READY",
          progress = 100,
          audioPath = File(packageDir, manifest.audioFile).absolutePath,
          subtitlePath = File(packageDir, manifest.subtitleFile).absolutePath,
          scriptPath = scriptPath,
          durationMs = manifest.durationMs,
          nextRetryAt = null,
          errorMessage = null,
          remoteChapterJobId = remoteJobId,
          updatedAt = now,
          completedAt = now,
        ),
      ),
    )

    bookDao.deleteScriptSegmentsForChapter(chapterId)
    if (scriptFile?.exists() == true) {
      val script =
        scriptFile.reader().use { reader ->
          gson.fromJson(reader, PackageScript::class.java)
        }
      bookDao.upsertScriptSegments(
        script.segments.map { segment ->
          ScriptSegmentEntity(
            id = "$parentBookId-$chapterId-${segment.id}",
            bookId = parentBookId,
            chapterId = chapterId,
            chapterIndex = existingChapter.indexInBook,
            startMs = segment.startMs,
            endMs = segment.endMs,
            title = segment.title,
            text = segment.text,
            kind = segment.kind,
          )
        },
      )
    }

    refreshBookProgress(parentBookId)
  }

  suspend fun updateChapterFromImportJob(job: ImportJobEntity) {
    val bookId = job.bookId ?: return
    val chapterId = job.chapterId ?: return
    updateChapterImportState(
      bookId = bookId,
      chapterId = chapterId,
      status = job.status.toChapterStatus(),
      progress = job.progress,
      errorMessage = job.errorMessage,
      retryCount = job.retryCount,
      nextRetryAt = job.nextRetryAt,
      remoteJobId = job.remoteJobId,
    )
  }

  suspend fun updateChapterImportState(
    bookId: String,
    chapterId: String,
    status: String,
    progress: Int,
    errorMessage: String?,
    retryCount: Int? = null,
    nextRetryAt: Long? = null,
    remoteJobId: String? = null,
    refreshParent: Boolean = true,
  ) {
    val existingChapter = bookDao.getChapter(chapterId) ?: return
    val now = System.currentTimeMillis()
    val nextStatus =
      if (existingChapter.hasPlayablePackage && status != "FAILED") {
        existingChapter.status
      } else {
        status
      }

    bookDao.upsertChapters(
      listOf(
        existingChapter.copy(
          status = nextStatus,
          progress = if (nextStatus == "READY") 100 else progress.coerceIn(0, 100),
          retryCount = retryCount ?: existingChapter.retryCount,
          nextRetryAt = nextRetryAt,
          errorMessage = errorMessage,
          remoteChapterJobId = remoteJobId ?: existingChapter.remoteChapterJobId,
          updatedAt = now,
          completedAt = if (nextStatus == "READY") now else existingChapter.completedAt,
        ),
      ),
    )
    if (refreshParent) {
      refreshBookProgress(bookId)
    }
  }

  suspend fun markChapterSubmissionFailed(bookId: String, chapterId: String, message: String) {
    updateChapterImportState(
      bookId = bookId,
      chapterId = chapterId,
      status = "FAILED",
      progress = 100,
      errorMessage = message,
      retryCount = 0,
      nextRetryAt = null,
    )
  }

  suspend fun updateLastPosition(
    bookId: String,
    chapterIndex: Int,
    globalPositionMs: Long,
    chapterPositionMs: Long,
  ) {
    val now = System.currentTimeMillis()
    bookDao.updateLastPosition(bookId, chapterIndex, globalPositionMs, now)
    bookDao.updateChapterPlayedPosition(bookId, chapterIndex, chapterPositionMs, now)
  }

  suspend fun deleteBook(bookId: String) {
    val book = bookDao.getBook(bookId) ?: return
    val packageDir = File(book.localPackageDir)

    bookDao.deleteChapters(bookId)
    bookDao.deleteScriptSegments(bookId)
    bookDao.deleteBook(bookId)
    importJobDao.deleteByBookId(bookId)

    if (packageDir.exists()) {
      packageDir.deleteRecursively()
    }
  }

  suspend fun refreshBookProgress(bookId: String) {
    val book = bookDao.getBook(bookId) ?: return
    val chapters = bookDao.getChaptersForBook(bookId)
    val readyCount = chapters.count { it.status == "READY" }
    val failedCount = chapters.count { it.status == "FAILED" }
    val nextStatus =
      when {
        chapters.isEmpty() -> book.status
        readyCount == chapters.size -> "READY"
        readyCount > 0 -> "PARTIAL_READY"
        failedCount == chapters.size -> "FAILED"
        else -> "IMPORTING"
      }
    val now = System.currentTimeMillis()

    bookDao.upsertBook(
      book.copy(
        status = nextStatus,
        chapterCount = chapters.size,
        readyChapterCount = readyCount,
        failedChapterCount = failedCount,
        durationMs = chapters.filter { it.status == "READY" }.sumOf { it.durationMs },
        updatedAt = now,
      ),
    )
  }
}

private fun sanitizeId(raw: String): String =
  raw.replace(Regex("[^A-Za-z0-9_-]"), "_").take(64).ifBlank { "discovery" }

private fun String.toChapterStatus(): String =
  when (this) {
    "READY" -> "READY"
    "FAILED" -> "FAILED"
    "DOWNLOADING" -> "DOWNLOADING"
    "QUEUED" -> "QUEUED"
    else -> "PROCESSING"
  }

private val ChapterEntity.hasPlayablePackage: Boolean
  get() = status == "READY" && !audioPath.isNullOrBlank() && !subtitlePath.isNullOrBlank()

private fun parseRemoteTimeMs(value: String?): Long? =
  value?.let { raw ->
    runCatching { Instant.parse(raw).toEpochMilli() }.getOrNull()
  }
