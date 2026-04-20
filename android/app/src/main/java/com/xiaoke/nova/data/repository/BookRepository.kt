package com.xiaoke.nova.data.repository

import java.io.File

import com.google.gson.annotations.SerializedName
import com.xiaoke.nova.data.local.BookDao
import com.xiaoke.nova.data.local.BookEntity
import com.xiaoke.nova.data.local.BookWithChapters
import com.xiaoke.nova.data.local.ChapterEntity
import com.xiaoke.nova.data.local.ImportJobDao

import kotlinx.coroutines.flow.Flow

data class PackageManifest(
  @SerializedName("bookId") val bookId: String,
  @SerializedName("title") val title: String,
  @SerializedName("sourceType") val sourceType: String,
  @SerializedName("sourceUrl") val sourceUrl: String,
  @SerializedName("language") val language: String,
  @SerializedName("coverFile") val coverFile: String?,
  @SerializedName("totalDurationMs") val totalDurationMs: Long,
  @SerializedName("chapters") val chapters: List<PackageChapterManifest>,
)

data class PackageChapterManifest(
  @SerializedName("title") val title: String,
  @SerializedName("durationMs") val durationMs: Long,
  @SerializedName("audioFile") val audioFile: String,
  @SerializedName("subtitleFile") val subtitleFile: String,
)

class BookRepository(
  private val bookDao: BookDao,
  private val importJobDao: ImportJobDao,
) {
  fun observeBooks(): Flow<List<BookWithChapters>> = bookDao.observeBooks()

  fun observeBook(bookId: String): Flow<BookWithChapters?> = bookDao.observeBook(bookId)

  suspend fun persistPackage(packageDir: File, manifest: PackageManifest) {
    val coverPath = manifest.coverFile?.let { File(packageDir, it).absolutePath }
    val now = System.currentTimeMillis()

    bookDao.upsertBook(
      BookEntity(
        id = manifest.bookId,
        title = manifest.title,
        sourceType = manifest.sourceType,
        sourceUri = manifest.sourceUrl,
        language = manifest.language,
        status = "READY",
        coverPath = coverPath,
        durationMs = manifest.totalDurationMs,
        localPackageDir = packageDir.absolutePath,
        lastPositionMs = 0L,
        createdAt = now,
      ),
    )

    bookDao.deleteChapters(manifest.bookId)
    bookDao.upsertChapters(
      manifest.chapters.mapIndexed { index, chapter ->
        ChapterEntity(
          id = "${manifest.bookId}-$index",
          bookId = manifest.bookId,
          indexInBook = index,
          title = chapter.title,
          audioPath = File(packageDir, chapter.audioFile).absolutePath,
          subtitlePath = File(packageDir, chapter.subtitleFile).absolutePath,
          durationMs = chapter.durationMs,
        )
      },
    )
  }

  suspend fun updateLastPosition(bookId: String, positionMs: Long) {
    bookDao.updateLastPosition(bookId, positionMs)
  }

  suspend fun deleteBook(bookId: String) {
    val book = bookDao.getBook(bookId) ?: return
    val packageDir = File(book.localPackageDir)

    bookDao.deleteChapters(bookId)
    bookDao.deleteBook(bookId)
    importJobDao.deleteByBookId(bookId)

    if (packageDir.exists()) {
      packageDir.deleteRecursively()
    }
  }
}
