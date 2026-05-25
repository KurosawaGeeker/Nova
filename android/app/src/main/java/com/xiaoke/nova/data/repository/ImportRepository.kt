package com.xiaoke.nova.data.repository

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64

import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf

import com.google.gson.Gson
import com.xiaoke.nova.data.local.ImportJobDao
import com.xiaoke.nova.data.local.ImportJobEntity
import com.xiaoke.nova.data.remote.BookDiscoveryResponse
import com.xiaoke.nova.data.remote.CreateBookChapterRequest
import com.xiaoke.nova.data.remote.CreateBookRequest
import com.xiaoke.nova.data.remote.DiscoverBookRequest
import com.xiaoke.nova.data.remote.DiscoveredChapterResponse
import com.xiaoke.nova.data.remote.FilePreviewRequest
import com.xiaoke.nova.data.remote.FilePreviewResponse
import com.xiaoke.nova.data.remote.NovaApi
import com.xiaoke.nova.data.remote.SubmitUrlRequest
import com.xiaoke.nova.work.BookImportMonitorWorker
import com.xiaoke.nova.work.ImportMonitorWorker

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.URI

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import retrofit2.HttpException
import kotlin.coroutines.cancellation.CancellationException

class ImportRepository(
  private val context: Context,
  private val api: NovaApi,
  private val importJobDao: ImportJobDao,
  private val bookRepository: BookRepository,
  private val gson: Gson,
) {
  private val submitMutex = Mutex()

  fun observeJobs(): Flow<List<ImportJobEntity>> = importJobDao.observeJobs()

  fun observeActiveJobs(): Flow<List<ImportJobEntity>> = importJobDao.observeActiveJobs()

  fun observeFinishedJobCount(): Flow<Int> = importJobDao.observeFinishedJobCount()

  fun observeJob(jobId: String): Flow<ImportJobEntity?> = importJobDao.observeJob(jobId)

  suspend fun submitUrl(url: String): String = submitUrlInternal(url)

  suspend fun discoverBook(url: String): BookDiscoveryResponse =
    api.discoverBook(DiscoverBookRequest(normalizeForLocalDedup(url)))

  suspend fun previewLocalFile(uri: Uri): FilePreviewResponse =
    withContext(Dispatchers.IO) {
      val metadata = readLocalFileMetadata(uri)
      metadata.sizeBytes?.let { sizeBytes ->
        if (sizeBytes > MAX_FILE_PREVIEW_BYTES) {
          throw IOException(
            "Selected file is ${formatUploadSize(sizeBytes)}; preview uploads are limited to ${formatUploadSize(MAX_FILE_PREVIEW_BYTES)}.",
          )
        }
      }

      val bytes = readLocalFileBytes(uri)
      val response =
        api.previewFile(
          FilePreviewRequest(
            fileName = metadata.fileName,
            fileType = metadata.mimeType,
            contentBase64 = Base64.encodeToString(bytes, Base64.NO_WRAP),
          ),
        )

      if (response.isSuccessful) {
        return@withContext response.body() ?: throw IOException("File preview response was empty.")
      }

      parsePreviewErrorBody(response.errorBody()?.string())?.let { preview ->
        return@withContext preview
      }
      throw HttpException(response)
    }

  suspend fun submitUrls(urls: List<String>): List<String> =
    urls
      .map(::normalizeForLocalDedup)
      .distinct()
      .map { url ->
        submitUrlInternal(url)
      }

  suspend fun importDiscoveredBook(
    discovery: BookDiscoveryResponse,
    selectedChapters: List<DiscoveredChapterResponse>,
  ): String {
    val dedupedChapters = selectedChapters.distinctBy { normalizeForLocalDedup(it.url) }
    require(dedupedChapters.isNotEmpty()) { "Select at least one chapter to import" }

    return runCatching {
      importDiscoveredBookRemotely(discovery, dedupedChapters)
    }.getOrElse { error ->
      if (error is CancellationException) {
        throw error
      }
      if (!shouldFallbackToChapterUrlImports(error)) {
        throw error
      }
      importDiscoveredBookWithChapterUrlFallback(discovery, dedupedChapters)
    }
  }

  private suspend fun importDiscoveredBookRemotely(
    discovery: BookDiscoveryResponse,
    selectedChapters: List<DiscoveredChapterResponse>,
  ): String {
    val sourceRootUrl = normalizeForLocalDedup(discovery.sourceUrl)
    val response =
      api.createBook(
        CreateBookRequest(
          discoveryId = discovery.discoveryId.takeIf { it.isNotBlank() },
          title = discovery.candidateBookTitle.ifBlank { "Discovered book" },
          sourceRootUrl = sourceRootUrl,
          chapters =
            selectedChapters
              .sortedWith(compareBy({ it.index }, { it.url }))
              .map { chapter ->
                CreateBookChapterRequest(
                  index = chapter.index,
                  title = chapter.title.ifBlank { "Chapter ${chapter.index + 1}" },
                  url = normalizeForLocalDedup(chapter.url),
                )
              },
        ),
      )
    val chapterIdsByIndex = response.chapterJobs.associate { it.index to it.chapterId }
    val chapterStatusesByIndex = response.chapterJobs.associate { it.index to it.status }
    val packageRoot = File(context.filesDir, "books/${response.bookId}")
    bookRepository.createDiscoveredBook(
      discovery = discovery,
      selectedChapters = selectedChapters,
      packageRoot = packageRoot,
      bookIdOverride = response.bookId,
      chapterIdsByIndex = chapterIdsByIndex,
      chapterStatusesByIndex = chapterStatusesByIndex,
    )

    val now = System.currentTimeMillis()
    importJobDao.upsert(
      ImportJobEntity(
        id = response.jobId,
        jobKind = "book_import",
        remoteJobId = response.jobId,
        bookId = response.bookId,
        chapterId = null,
        normalizedUrl = sourceRootUrl,
        status = "QUEUED",
        progress = 0,
        retryCount = 0,
        maxRetries = 2,
        nextRetryAt = null,
        errorMessage = null,
        createdAt = now,
        updatedAt = now,
      ),
    )
    enqueueBookMonitor(response.bookId)
    return response.bookId
  }

  private suspend fun importDiscoveredBookWithChapterUrlFallback(
    discovery: BookDiscoveryResponse,
    selectedChapters: List<DiscoveredChapterResponse>,
  ): String {
    val now = System.currentTimeMillis()
    val packageRoot = File(context.filesDir, "books/pending-$now")
    val createdBook = bookRepository.createDiscoveredBook(discovery, selectedChapters, packageRoot)

    createdBook.chapters.forEach { chapter ->
      runCatching {
        submitUrlInternal(
          url = chapter.sourceUrl,
          jobKind = "chapter_import",
          bookId = createdBook.bookId,
          chapterId = chapter.id,
        )
      }.onFailure { error ->
        bookRepository.markChapterSubmissionFailed(
          bookId = createdBook.bookId,
          chapterId = chapter.id,
          message = error.message ?: "Chapter import submission failed",
        )
      }
    }

    return createdBook.bookId
  }

  private suspend fun submitUrlInternal(
    url: String,
    jobKind: String = "single_url",
    bookId: String? = null,
    chapterId: String? = null,
  ): String = submitMutex.withLock {
    val localNormalizedUrl = normalizeForLocalDedup(url)
    if (chapterId != null) {
      importJobDao.getActiveJobByChapterId(chapterId)?.let { existing ->
        enqueueMonitor(existing.id)
        return@withLock existing.id
      }
    }

    importJobDao.getActiveJobByNormalizedUrl(localNormalizedUrl)?.let { existing ->
      if (chapterId == null || existing.chapterId == chapterId) {
        enqueueMonitor(existing.id)
        return@withLock existing.id
      }
    }

    val response = api.submitUrl(SubmitUrlRequest(localNormalizedUrl))
    val remoteNormalizedUrl = normalizeForLocalDedup(response.normalizedUrl)
    importJobDao.getActiveJobByNormalizedUrl(remoteNormalizedUrl)?.let { existing ->
      if (chapterId == null || existing.chapterId == chapterId) {
        enqueueMonitor(existing.id)
        return@withLock existing.id
      }
    }

    val now = System.currentTimeMillis()
    val job =
      ImportJobEntity(
        id = response.jobId,
        jobKind = jobKind,
        remoteJobId = response.jobId,
        bookId = bookId,
        chapterId = chapterId,
        normalizedUrl = remoteNormalizedUrl,
        status = "QUEUED",
        progress = 0,
        retryCount = 0,
        maxRetries = 2,
        nextRetryAt = null,
        errorMessage = null,
        createdAt = now,
        updatedAt = now,
      )
    importJobDao.upsert(job)
    bookRepository.updateChapterFromImportJob(job)

    enqueueMonitor(response.jobId)
    response.jobId
  }

  fun enqueueMonitor(jobId: String) {
    val request =
      OneTimeWorkRequestBuilder<ImportMonitorWorker>()
        .setInputData(workDataOf(ImportMonitorWorker.KEY_JOB_ID to jobId))
        .build()

    WorkManager.getInstance(context).enqueueUniqueWork(
      "import-$jobId",
      ExistingWorkPolicy.REPLACE,
      request,
    )
  }

  fun enqueueBookMonitor(bookId: String) {
    val request =
      OneTimeWorkRequestBuilder<BookImportMonitorWorker>()
        .setInputData(workDataOf(BookImportMonitorWorker.KEY_BOOK_ID to bookId))
        .build()

    WorkManager.getInstance(context).enqueueUniqueWork(
      "book-import-$bookId",
      ExistingWorkPolicy.REPLACE,
      request,
    )
  }

  suspend fun deleteJob(jobId: String) {
    WorkManager.getInstance(context).cancelUniqueWork("import-$jobId")
    importJobDao.deleteById(jobId)
  }

  suspend fun clearFinishedJobs() {
    importJobDao.deleteFinishedJobs()
  }

  private fun readLocalFileMetadata(uri: Uri): LocalFileMetadata {
    var fileName: String? = null
    var sizeBytes: Long? = null
    context.contentResolver
      .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)
      ?.use { cursor ->
        if (cursor.moveToFirst()) {
          val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (nameIndex >= 0 && !cursor.isNull(nameIndex)) {
            fileName = cursor.getString(nameIndex)
          }

          val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
          if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) {
            sizeBytes = cursor.getLong(sizeIndex).takeIf { it >= 0L }
          }
        }
      }

    return LocalFileMetadata(
      fileName =
        fileName
          ?.takeIf { it.isNotBlank() }
          ?: uri.lastPathSegment
            ?.substringAfterLast('/')
            ?.takeIf { it.isNotBlank() }
          ?: "selected-file",
      mimeType = context.contentResolver.getType(uri),
      sizeBytes = sizeBytes,
    )
  }

  private fun readLocalFileBytes(uri: Uri): ByteArray {
    val inputStream =
      context.contentResolver.openInputStream(uri)
        ?: throw IOException("Could not open the selected file.")

    inputStream.use { input ->
      val output = ByteArrayOutputStream()
      val buffer = ByteArray(FILE_PREVIEW_BUFFER_SIZE)
      var totalBytes = 0L
      while (true) {
        val read = input.read(buffer)
        if (read == -1) {
          break
        }
        totalBytes += read.toLong()
        if (totalBytes > MAX_FILE_PREVIEW_BYTES) {
          throw IOException(
            "Selected file is larger than ${formatUploadSize(MAX_FILE_PREVIEW_BYTES)}. Choose a smaller text file for preview.",
          )
        }
        output.write(buffer, 0, read)
      }
      return output.toByteArray()
    }
  }

  private fun parsePreviewErrorBody(rawBody: String?): FilePreviewResponse? {
    if (rawBody.isNullOrBlank()) {
      return null
    }
    return runCatching {
      gson.fromJson(rawBody, FilePreviewResponse::class.java)
    }.getOrNull()
  }
}

private const val MAX_FILE_PREVIEW_BYTES = 12L * 1024L * 1024L
private const val FILE_PREVIEW_BUFFER_SIZE = 64 * 1024

private data class LocalFileMetadata(
  val fileName: String,
  val mimeType: String?,
  val sizeBytes: Long?,
)

private fun formatUploadSize(bytes: Long): String {
  val mib = bytes.toDouble() / (1024.0 * 1024.0)
  return if (mib >= 1.0) {
    "%.1f MB".format(mib)
  } else {
    "${bytes / 1024L} KB"
  }
}

private fun normalizeForLocalDedup(url: String): String {
  val trimmed = url.trim()
  return runCatching {
    val parsed = URI(trimmed).normalize()
    val scheme = parsed.scheme?.lowercase()
    val host = parsed.host?.lowercase()
    if ((scheme == "http" || scheme == "https") && !host.isNullOrBlank()) {
      URI(
        scheme,
        parsed.userInfo,
        host,
        parsed.port,
        parsed.path,
        parsed.query,
        parsed.fragment,
      ).toString()
    } else {
      trimmed
    }
  }.getOrElse {
    trimmed
  }
}

private fun shouldFallbackToChapterUrlImports(error: Throwable): Boolean {
  if (error is IOException) {
    return true
  }
  val statusCode = (error as? HttpException)?.code() ?: return false
  return statusCode == 404 || statusCode == 405 || statusCode == 501 || statusCode in 500..599
}
