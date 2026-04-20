package com.xiaoke.nova.data.repository

import android.content.Context

import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf

import com.xiaoke.nova.data.local.ImportJobDao
import com.xiaoke.nova.data.local.ImportJobEntity
import com.xiaoke.nova.data.remote.NovaApi
import com.xiaoke.nova.data.remote.SubmitUrlRequest
import com.xiaoke.nova.work.ImportMonitorWorker

import kotlinx.coroutines.flow.Flow

class ImportRepository(
  private val context: Context,
  private val api: NovaApi,
  private val importJobDao: ImportJobDao,
) {
  fun observeJobs(): Flow<List<ImportJobEntity>> = importJobDao.observeJobs()

  fun observeJob(jobId: String): Flow<ImportJobEntity?> = importJobDao.observeJob(jobId)

  suspend fun submitUrl(url: String): String = submitUrlInternal(url)

  suspend fun submitUrls(urls: List<String>): List<String> =
    urls.map { url ->
      submitUrlInternal(url)
    }

  private suspend fun submitUrlInternal(url: String): String {
    val response = api.submitUrl(SubmitUrlRequest(url.trim()))
    val now = System.currentTimeMillis()
    importJobDao.upsert(
      ImportJobEntity(
        id = response.jobId,
        remoteJobId = response.jobId,
        bookId = null,
        normalizedUrl = response.normalizedUrl,
        status = "QUEUED",
        progress = 0,
        errorMessage = null,
        createdAt = now,
        updatedAt = now,
      ),
    )

    enqueueMonitor(response.jobId)
    return response.jobId
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
}
