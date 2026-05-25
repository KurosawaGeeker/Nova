package com.xiaoke.nova.work

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo

import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf

import java.io.File
import java.io.FileReader
import java.io.FileOutputStream
import java.net.URI
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream

import com.xiaoke.nova.BuildConfig
import com.xiaoke.nova.NovaApp
import com.xiaoke.nova.R
import com.xiaoke.nova.data.local.ChapterEntity
import com.xiaoke.nova.data.local.ImportJobEntity
import com.xiaoke.nova.data.remote.RemoteBookStatusResponse
import com.xiaoke.nova.data.remote.RemoteImportJobResponse
import com.xiaoke.nova.data.repository.ChapterPackageManifest
import com.xiaoke.nova.data.repository.PackageManifest

import java.time.Instant
import kotlinx.coroutines.delay

object NotificationHelper {
  const val IMPORT_CHANNEL = "imports"

  fun ensureChannels(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(
        IMPORT_CHANNEL,
        "Imports",
        NotificationManager.IMPORTANCE_LOW,
      ),
    )
  }

  fun buildProgressNotification(
    context: Context,
    title: String,
    text: String,
    progress: Int,
    indeterminate: Boolean = false,
  ) =
    NotificationCompat.Builder(context, IMPORT_CHANNEL)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle(title)
      .setContentText(text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setProgress(100, progress.coerceIn(0, 100), indeterminate)
      .build()
}

class ImportMonitorWorker(
  appContext: Context,
  params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
  override suspend fun doWork(): Result {
    val jobId = inputData.getString(KEY_JOB_ID) ?: return Result.failure()
    val container = (applicationContext as NovaApp).container

    return runCatching {
      setForeground(createForegroundInfo("Waiting for article processing", 5))

      repeat(180) {
        val remote = container.api.getImportJob(jobId)
        val existing = container.database.importJobDao().getJob(jobId)
        val merged =
          mergeRemoteJob(existing, jobId, remote).let { job ->
            if (remote.status == "READY" && !remote.downloadUrl.isNullOrBlank()) {
              job.copy(status = "DOWNLOADING", progress = job.progress.coerceAtLeast(95))
            } else {
              job
            }
          }
        container.database.importJobDao().upsert(merged)
        container.bookRepository.updateChapterFromImportJob(merged)

        when (remote.status) {
          "READY" -> {
            if (remote.bookId.isNullOrBlank() || remote.downloadUrl.isNullOrBlank()) {
              markImportFailed(jobId, "Import finished without a downloadable package")
              return@runCatching Result.failure()
            }
            DownloadPackageWorker.enqueue(applicationContext, jobId, remote.bookId, remote.downloadUrl)
            return@runCatching Result.success()
          }

          "FAILED" -> return@runCatching Result.failure()
        }

        setForeground(createForegroundInfo("Converting article into audio", remote.progress))
        delay(5_000)
      }

      markImportFailed(jobId, "Import timed out while waiting for backend processing")
      Result.failure()
    }.getOrElse { error ->
      if (runAttemptCount < MAX_RETRIES) {
        recordImportRetry(jobId, error.message ?: "Import monitor failed")
        Result.retry()
      } else {
        markImportFailed(jobId, error.message ?: "Import monitor failed")
        Result.failure()
      }
    }
  }

  private fun createForegroundInfo(title: String, progress: Int) =
    ForegroundInfo(
      1001,
      NotificationHelper.buildProgressNotification(
        applicationContext,
        title = title,
        text = applicationContext.getString(R.string.app_name),
        progress = progress,
        indeterminate = progress <= 0,
      ),
      ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
    )

  private suspend fun markImportFailed(jobId: String, message: String) {
    val container = (applicationContext as NovaApp).container
    val existing = container.database.importJobDao().getJob(jobId)
    val failedJob =
      (existing ?: fallbackJob(jobId)).copy(
        status = "FAILED",
        progress = existing?.progress ?: 100,
        retryCount = existing?.retryCount ?: MAX_RETRIES,
        nextRetryAt = null,
        errorMessage = message,
        updatedAt = System.currentTimeMillis(),
      )
    container.database.importJobDao().upsert(failedJob)
    container.bookRepository.updateChapterFromImportJob(failedJob)
  }

  private suspend fun recordImportRetry(jobId: String, message: String) {
    val container = (applicationContext as NovaApp).container
    val existing = container.database.importJobDao().getJob(jobId)
    val maxRetries = existing?.maxRetries ?: MAX_RETRIES
    val retryCount = (runAttemptCount + 1).coerceAtMost(maxRetries)
    val retryJob =
      (existing ?: fallbackJob(jobId)).copy(
        retryCount = retryCount,
        maxRetries = maxRetries,
        nextRetryAt = System.currentTimeMillis() + retryDelayMs(retryCount),
        errorMessage = message,
        updatedAt = System.currentTimeMillis(),
      )
    container.database.importJobDao().upsert(retryJob)
    container.bookRepository.updateChapterFromImportJob(retryJob)
  }

  companion object {
    const val KEY_JOB_ID = "job_id"
    private const val MAX_RETRIES = 2
  }
}

class BookImportMonitorWorker(
  appContext: Context,
  params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
  override suspend fun doWork(): Result {
    val bookId = inputData.getString(KEY_BOOK_ID) ?: return Result.failure()
    val container = (applicationContext as NovaApp).container

    return runCatching {
      setForeground(createForegroundInfo("Waiting for book processing", 5))

      repeat(MAX_POLLS) {
        val remote = container.api.getBook(bookId)
        syncRemoteBook(remote)

        if (remote.hasOnlyTerminalChapters()) {
          return@runCatching Result.success()
        }

        setForeground(createForegroundInfo("Converting chapters into audio", remote.averageProgress()))
        delay(POLL_DELAY_MS)
      }

      if (runAttemptCount < MAX_RETRIES) {
        Result.retry()
      } else {
        markBookMonitorFailed(bookId, "Book import timed out while waiting for backend processing")
        Result.failure()
      }
    }.getOrElse { error ->
      if (runAttemptCount < MAX_RETRIES) {
        recordBookMonitorRetry(bookId, error.message ?: "Book import monitor failed")
        Result.retry()
      } else {
        markBookMonitorFailed(bookId, error.message ?: "Book import monitor failed")
        Result.failure()
      }
    }
  }

  private suspend fun syncRemoteBook(remote: RemoteBookStatusResponse) {
    val container = (applicationContext as NovaApp).container
    val importJobDao = container.database.importJobDao()

    container.bookRepository.applyRemoteBookStatus(remote)
    val localChapters =
      container.database.bookDao()
        .getChaptersForBook(remote.bookId)
        .associateBy { it.id }

    remote.chapters.forEach { chapter ->
      val localChapter = localChapters[chapter.chapterId]
      val jobId = chapterDownloadJobId(remote.bookId, chapter.chapterId)
      val existingJob = importJobDao.getJob(jobId)
      val remoteReadyForDownload = chapter.status == "READY" && !chapter.downloadUrl.isNullOrBlank()
      val localPackageReady = localChapter?.hasPlayablePackage == true || existingJob?.status == "READY"
      val downloadInFlight = existingJob?.status == "DOWNLOADING"
      val downloadFailed = existingJob?.status == "FAILED"
      val shouldDownload =
        remoteReadyForDownload && !localPackageReady && !downloadInFlight && !downloadFailed
      val localJobStatus =
        when {
          downloadFailed -> "FAILED"
          remoteReadyForDownload && !localPackageReady && (shouldDownload || downloadInFlight) -> "DOWNLOADING"
          localPackageReady && chapter.status == "READY" -> "READY"
          else -> chapter.status
        }
      val retryCount = if (downloadFailed) existingJob?.retryCount ?: chapter.retryCount else chapter.retryCount
      val nextRetryAt = if (downloadFailed) existingJob?.nextRetryAt else parseRemoteTimeMs(chapter.nextRetryAt)
      val errorMessage = if (downloadFailed) existingJob?.errorMessage else chapter.errorMessage
      val now = System.currentTimeMillis()
      val job =
        ImportJobEntity(
          id = jobId,
          jobKind = "chapter_import",
          remoteJobId = existingJob?.remoteJobId ?: chapter.chapterId,
          bookId = remote.bookId,
          chapterId = chapter.chapterId,
          normalizedUrl = localChapter?.sourceUrl.orEmpty(),
          status = localJobStatus,
          progress =
            if (localJobStatus == "DOWNLOADING") {
              chapter.progress.coerceAtLeast(95).coerceAtMost(99)
            } else {
              chapter.progress.coerceIn(0, 100)
            },
          retryCount = retryCount,
          maxRetries = chapter.maxRetries,
          nextRetryAt = nextRetryAt,
          errorMessage = errorMessage,
          createdAt = existingJob?.createdAt ?: now,
          updatedAt = now,
        )
      importJobDao.upsert(job)

      if (localJobStatus == "DOWNLOADING") {
        container.bookRepository.updateChapterImportState(
          bookId = remote.bookId,
          chapterId = chapter.chapterId,
          status = "DOWNLOADING",
          progress = job.progress,
          errorMessage = errorMessage,
          retryCount = retryCount,
          nextRetryAt = nextRetryAt,
          remoteJobId = job.remoteJobId,
          refreshParent = false,
        )
      }

      if (downloadFailed) {
        container.bookRepository.updateChapterImportState(
          bookId = remote.bookId,
          chapterId = chapter.chapterId,
          status = "FAILED",
          progress = job.progress,
          errorMessage = errorMessage,
          retryCount = retryCount,
          nextRetryAt = nextRetryAt,
          remoteJobId = job.remoteJobId,
          refreshParent = false,
        )
      }

      if (shouldDownload) {
        DownloadPackageWorker.enqueue(
          applicationContext,
          jobId,
          remote.bookId,
          chapter.downloadUrl!!,
        )
      }
    }

    updateParentImportJob(remote)
  }

  private suspend fun updateParentImportJob(remote: RemoteBookStatusResponse) {
    val container = (applicationContext as NovaApp).container
    val importJobDao = container.database.importJobDao()
    val existingJob = importJobDao.getBookImportJob(remote.bookId) ?: return
    val terminal = remote.hasOnlyTerminalChapters()
    val nextStatus =
      when {
        terminal && remote.readyChapterCount > 0 -> "READY"
        terminal -> "FAILED"
        else -> remote.status
      }
    importJobDao.upsert(
      existingJob.copy(
        status = nextStatus,
        progress = if (terminal) 100 else remote.averageProgress(),
        nextRetryAt = null,
        errorMessage = null,
        updatedAt = System.currentTimeMillis(),
      ),
    )
  }

  private fun createForegroundInfo(title: String, progress: Int) =
    ForegroundInfo(
      1003,
      NotificationHelper.buildProgressNotification(
        applicationContext,
        title = title,
        text = applicationContext.getString(R.string.app_name),
        progress = progress,
        indeterminate = progress <= 0,
      ),
      ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
    )

  private suspend fun recordBookMonitorRetry(bookId: String, message: String) {
    val container = (applicationContext as NovaApp).container
    val importJobDao = container.database.importJobDao()
    val existingJob = importJobDao.getBookImportJob(bookId) ?: return
    val retryCount = (runAttemptCount + 1).coerceAtMost(existingJob.maxRetries)
    importJobDao.upsert(
      existingJob.copy(
        retryCount = retryCount,
        nextRetryAt = System.currentTimeMillis() + retryDelayMs(retryCount),
        errorMessage = message,
        updatedAt = System.currentTimeMillis(),
      ),
    )
  }

  private suspend fun markBookMonitorFailed(bookId: String, message: String) {
    val container = (applicationContext as NovaApp).container
    val importJobDao = container.database.importJobDao()
    val existingJob = importJobDao.getBookImportJob(bookId) ?: return
    importJobDao.upsert(
      existingJob.copy(
        status = "FAILED",
        progress = existingJob.progress,
        retryCount = existingJob.maxRetries,
        nextRetryAt = null,
        errorMessage = message,
        updatedAt = System.currentTimeMillis(),
      ),
    )
  }

  companion object {
    const val KEY_BOOK_ID = "book_id"
    private const val MAX_POLLS = 360
    private const val MAX_RETRIES = 2
    private const val POLL_DELAY_MS = 5_000L
  }
}

class DownloadPackageWorker(
  appContext: Context,
  params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
  override suspend fun doWork(): Result {
    val jobId = inputData.getString(KEY_JOB_ID) ?: return Result.failure()
    val remoteBookId = inputData.getString(KEY_BOOK_ID) ?: return Result.failure()
    val downloadUrl = inputData.getString(KEY_DOWNLOAD_URL) ?: return Result.failure()
    val container = (applicationContext as NovaApp).container

    return runCatching {
      setForeground(createForegroundInfo("Downloading audiobook package", 10))
      val existingJob = container.database.importJobDao().getJob(jobId)
      val parentBookId = existingJob?.bookId?.takeIf { !existingJob.chapterId.isNullOrBlank() }
      val parentBook = parentBookId?.let { container.database.bookDao().getBook(it) }

      val response = container.api.downloadPackage(normalizeDownloadUrl(downloadUrl))
      val body = response.body() ?: error("Package response body was empty")

      val booksRoot = File(applicationContext.filesDir, "books")
      booksRoot.mkdirs()
      val packageRoot =
        if (existingJob?.chapterId != null && parentBook != null) {
          File(File(parentBook.localPackageDir), "chapters/${existingJob.chapterId}")
        } else {
          File(booksRoot, remoteBookId)
        }
      if (packageRoot.exists()) {
        packageRoot.deleteRecursively()
      }
      packageRoot.mkdirs()

      val zipFile = File(packageRoot, "package.zip")
      FileOutputStream(zipFile).use { output ->
        body.byteStream().use { input ->
          input.copyTo(output)
        }
      }

      setForeground(createForegroundInfo("Unpacking audiobook package", 70))
      unzip(zipFile, packageRoot)

      if (existingJob?.chapterId != null && parentBookId != null) {
        val manifestFile = File(packageRoot, "manifest.json")
        if (manifestFile.exists()) {
          val manifest =
            FileReader(manifestFile).use { reader ->
              container.gson.fromJson(reader, PackageManifest::class.java)
            }
          container.bookRepository.persistChapterPackage(
            parentBookId = parentBookId,
            chapterId = existingJob.chapterId,
            packageDir = packageRoot,
            manifest = manifest,
            remoteJobId = jobId,
          )
        } else {
          val chapterFile = File(packageRoot, "chapter.json")
          val manifest =
            FileReader(chapterFile).use { reader ->
              container.gson.fromJson(reader, ChapterPackageManifest::class.java)
            }
          container.bookRepository.persistChapterPackage(
            parentBookId = parentBookId,
            chapterId = existingJob.chapterId,
            packageDir = packageRoot,
            manifest = manifest,
            remoteJobId = jobId,
          )
        }
      } else {
        val manifestFile = File(packageRoot, "manifest.json")
        val manifest =
          FileReader(manifestFile).use { reader ->
            container.gson.fromJson(reader, PackageManifest::class.java)
          }
        container.bookRepository.persistPackage(packageRoot, manifest)
      }
      val existing = container.database.importJobDao().getJob(jobId)
      val readyJob =
        (existing ?: fallbackJob(jobId)).copy(
          bookId = parentBookId ?: remoteBookId,
          status = "READY",
          progress = 100,
          nextRetryAt = null,
          errorMessage = null,
          updatedAt = System.currentTimeMillis(),
        )
      container.database.importJobDao().upsert(readyJob)
      container.bookRepository.updateChapterFromImportJob(readyJob)
      zipFile.delete()
    }.fold(
      onSuccess = { Result.success() },
      onFailure = { error ->
        val existing = container.database.importJobDao().getJob(jobId)
        val maxRetries = existing?.maxRetries ?: MAX_RETRIES
        val canRetry = runAttemptCount < maxRetries
        val retryCount =
          if (canRetry) {
            (runAttemptCount + 1).coerceAtMost(maxRetries)
          } else {
            maxRetries
          }
        val failedJob =
          (existing ?: fallbackJob(jobId)).copy(
            bookId = existing?.bookId ?: remoteBookId,
            status = if (canRetry) "DOWNLOADING" else "FAILED",
            progress = if (canRetry) existing?.progress ?: 95 else 100,
            retryCount = retryCount,
            maxRetries = maxRetries,
            nextRetryAt = if (canRetry) System.currentTimeMillis() + retryDelayMs(retryCount) else null,
            errorMessage = error.message ?: "Download failed",
            updatedAt = System.currentTimeMillis(),
          )
        container.database.importJobDao().upsert(failedJob)
        container.bookRepository.updateChapterFromImportJob(failedJob)
        if (canRetry) Result.retry() else Result.failure()
      },
    )
  }

  private fun createForegroundInfo(title: String, progress: Int) =
    ForegroundInfo(
      1002,
      NotificationHelper.buildProgressNotification(
        applicationContext,
        title = title,
        text = applicationContext.getString(R.string.app_name),
        progress = progress,
      ),
      ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
    )

  companion object {
    const val KEY_JOB_ID = "job_id"
    const val KEY_BOOK_ID = "book_id"
    const val KEY_DOWNLOAD_URL = "download_url"
    private const val MAX_RETRIES = 2

    fun enqueue(context: Context, jobId: String, bookId: String, downloadUrl: String) {
      val request =
        OneTimeWorkRequestBuilder<DownloadPackageWorker>()
          .setInputData(
            workDataOf(
              KEY_JOB_ID to jobId,
              KEY_BOOK_ID to bookId,
              KEY_DOWNLOAD_URL to downloadUrl,
            ),
          )
          .build()

      WorkManager.getInstance(context).enqueueUniqueWork(
        "download-$jobId",
        ExistingWorkPolicy.REPLACE,
        request,
      )
    }
  }
}

private fun mergeRemoteJob(
  existing: ImportJobEntity?,
  jobId: String,
  remote: RemoteImportJobResponse,
): ImportJobEntity {
  val now = System.currentTimeMillis()
  return (existing ?: fallbackJob(jobId)).copy(
    bookId =
      if (existing?.chapterId != null) {
        existing.bookId
      } else {
        remote.bookId ?: existing?.bookId
      },
    status = remote.status,
    progress = remote.progress,
    nextRetryAt = null,
    errorMessage = remote.errorMessage,
    updatedAt = now,
  )
}

private fun fallbackJob(jobId: String): ImportJobEntity =
  ImportJobEntity(
    id = jobId,
    jobKind = "single_url",
    remoteJobId = jobId,
    bookId = null,
    chapterId = null,
    normalizedUrl = "",
    status = "QUEUED",
    progress = 0,
    retryCount = 0,
    maxRetries = 2,
    nextRetryAt = null,
    errorMessage = null,
    createdAt = System.currentTimeMillis(),
    updatedAt = System.currentTimeMillis(),
  )

private fun retryDelayMs(retryCount: Int): Long =
  if (retryCount <= 1) 30_000L else 120_000L

private fun RemoteBookStatusResponse.averageProgress(): Int =
  if (chapters.isEmpty()) {
    0
  } else {
    chapters.sumOf { it.progress.coerceIn(0, 100) } / chapters.size
  }

private fun RemoteBookStatusResponse.hasOnlyTerminalChapters(): Boolean =
  chapters.isNotEmpty() && chapters.all { it.status.isTerminalChapterStatus() }

private fun String.isTerminalChapterStatus(): Boolean =
  this == "READY" || this == "FAILED" || this == "SKIPPED"

private val ChapterEntity.hasPlayablePackage: Boolean
  get() = status == "READY" && !audioPath.isNullOrBlank() && !subtitlePath.isNullOrBlank()

private fun chapterDownloadJobId(bookId: String, chapterId: String): String =
  "book_${bookId}_chapter_${chapterId}".replace(Regex("[^A-Za-z0-9_-]"), "_")

private fun parseRemoteTimeMs(value: String?): Long? =
  value?.let { raw ->
    runCatching { Instant.parse(raw).toEpochMilli() }.getOrNull()
  }

private fun unzip(zipFile: File, destination: File) {
  val destinationRoot = destination.canonicalFile
  ZipInputStream(zipFile.inputStream().buffered()).use { zipInput ->
    var entry: ZipEntry? = zipInput.nextEntry
    while (entry != null) {
      val currentEntry = entry
      val output = File(destinationRoot, currentEntry.name).canonicalFile
      require(output.path.startsWith(destinationRoot.path + File.separator) || output == destinationRoot) {
        "Blocked invalid zip entry: ${currentEntry.name}"
      }
      if (currentEntry.isDirectory) {
        output.mkdirs()
      } else {
        output.parentFile?.mkdirs()
        FileOutputStream(output).use { target ->
          zipInput.copyTo(target)
        }
      }
      zipInput.closeEntry()
      entry = zipInput.nextEntry
    }
  }
}

private fun normalizeDownloadUrl(rawUrl: String): String {
  val target = URI(rawUrl)
  val backendBase = URI(BuildConfig.API_BASE_URL)

  if (!target.isAbsolute) {
    return backendBase.resolve(rawUrl).toString()
  }

  if (target.host != "localhost" && target.host != "127.0.0.1") {
    return rawUrl
  }

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
