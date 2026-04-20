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

import com.google.gson.Gson
import com.xiaoke.nova.NovaApp
import com.xiaoke.nova.R
import com.xiaoke.nova.BuildConfig
import com.xiaoke.nova.data.local.ImportJobEntity
import com.xiaoke.nova.data.remote.RemoteImportJobResponse
import com.xiaoke.nova.data.repository.PackageManifest

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

    setForeground(createForegroundInfo("Waiting for article processing", 5))

    repeat(180) {
      val remote = container.api.getImportJob(jobId)
      val existing = container.database.importJobDao().getJob(jobId)
      container.database.importJobDao().upsert(
        mergeRemoteJob(existing, jobId, remote),
      )

      when (remote.status) {
        "READY" -> {
          if (remote.bookId.isNullOrBlank() || remote.downloadUrl.isNullOrBlank()) {
            return Result.failure()
          }
          DownloadPackageWorker.enqueue(applicationContext, jobId, remote.bookId, remote.downloadUrl)
          return Result.success()
        }

        "FAILED" -> return Result.failure()
      }

      setForeground(createForegroundInfo("Converting article into audio", remote.progress))
      delay(5_000)
    }

    return Result.retry()
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

  companion object {
    const val KEY_JOB_ID = "job_id"
  }
}

class DownloadPackageWorker(
  appContext: Context,
  params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
  override suspend fun doWork(): Result {
    val jobId = inputData.getString(KEY_JOB_ID) ?: return Result.failure()
    val bookId = inputData.getString(KEY_BOOK_ID) ?: return Result.failure()
    val downloadUrl = inputData.getString(KEY_DOWNLOAD_URL) ?: return Result.failure()
    val container = (applicationContext as NovaApp).container

    return runCatching {
      setForeground(createForegroundInfo("Downloading audiobook package", 10))

      val response = container.api.downloadPackage(normalizeDownloadUrl(downloadUrl))
      val body = response.body() ?: error("Package response body was empty")

      val booksRoot = File(applicationContext.filesDir, "books")
      booksRoot.mkdirs()
      val packageRoot = File(booksRoot, bookId)
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

      val manifestFile = File(packageRoot, "manifest.json")
      val manifest =
        FileReader(manifestFile).use { reader ->
          container.gson.fromJson(reader, PackageManifest::class.java)
        }

      container.bookRepository.persistPackage(packageRoot, manifest)
      val existing = container.database.importJobDao().getJob(jobId)
      container.database.importJobDao().upsert(
        (existing ?: fallbackJob(jobId)).copy(
          bookId = bookId,
          status = "READY",
          progress = 100,
          errorMessage = null,
          updatedAt = System.currentTimeMillis(),
        ),
      )
      zipFile.delete()
    }.fold(
      onSuccess = { Result.success() },
      onFailure = { error ->
        val existing = container.database.importJobDao().getJob(jobId)
        container.database.importJobDao().upsert(
          (existing ?: fallbackJob(jobId)).copy(
            bookId = bookId,
            status = "FAILED",
            progress = 100,
            errorMessage = error.message ?: "Download failed",
            updatedAt = System.currentTimeMillis(),
          ),
        )
        Result.failure()
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
        "download-$bookId",
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
    bookId = remote.bookId ?: existing?.bookId,
    status = remote.status,
    progress = remote.progress,
    errorMessage = remote.errorMessage,
    updatedAt = now,
  )
}

private fun fallbackJob(jobId: String): ImportJobEntity =
  ImportJobEntity(
    id = jobId,
    remoteJobId = jobId,
    bookId = null,
    normalizedUrl = "",
    status = "QUEUED",
    progress = 0,
    errorMessage = null,
    createdAt = System.currentTimeMillis(),
    updatedAt = System.currentTimeMillis(),
  )

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
