package com.xiaoke.nova.data.local

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Embedded
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Relation
import androidx.room.RoomDatabase
import androidx.room.Transaction

import kotlinx.coroutines.flow.Flow

@Entity(tableName = "books")
data class BookEntity(
  @PrimaryKey val id: String,
  val title: String,
  val description: String? = null,
  val kind: String = "single_article",
  val sourceType: String,
  val sourceUri: String,
  val sourceRootUrl: String = sourceUri,
  val language: String,
  val status: String,
  val coverPath: String?,
  val chapterCount: Int = 0,
  val readyChapterCount: Int = 0,
  val failedChapterCount: Int = 0,
  val durationMs: Long,
  val localPackageDir: String,
  val lastChapterIndex: Int = 0,
  val lastPositionMs: Long,
  val lastOpenedAt: Long? = null,
  val createdAt: Long,
  val updatedAt: Long = createdAt,
)

@Entity(tableName = "chapters", primaryKeys = ["id"])
data class ChapterEntity(
  val id: String,
  val bookId: String,
  val indexInBook: Int,
  val title: String,
  val sourceUrl: String = "",
  val status: String = "READY",
  val progress: Int = 100,
  val audioPath: String?,
  val subtitlePath: String?,
  val scriptPath: String? = null,
  val durationMs: Long,
  val playedPositionMs: Long = 0L,
  val retryCount: Int = 0,
  val maxRetries: Int = 2,
  val nextRetryAt: Long? = null,
  val errorMessage: String? = null,
  val remoteChapterJobId: String? = null,
  val createdAt: Long = System.currentTimeMillis(),
  val updatedAt: Long = createdAt,
  val completedAt: Long? = createdAt,
)

@Entity(tableName = "script_segments", primaryKeys = ["id"])
data class ScriptSegmentEntity(
  val id: String,
  val bookId: String,
  val chapterId: String,
  val chapterIndex: Int,
  val startMs: Long,
  val endMs: Long,
  val title: String?,
  val text: String,
  val kind: String,
)

@Entity(tableName = "import_jobs")
data class ImportJobEntity(
  @PrimaryKey val id: String,
  val jobKind: String = "single_url",
  val remoteJobId: String,
  val bookId: String?,
  val chapterId: String? = null,
  val normalizedUrl: String,
  val status: String,
  val progress: Int,
  val retryCount: Int = 0,
  val maxRetries: Int = 2,
  val nextRetryAt: Long? = null,
  val errorMessage: String?,
  val createdAt: Long,
  val updatedAt: Long,
)

data class BookWithChapters(
  @Embedded val book: BookEntity,
  @Relation(parentColumn = "id", entityColumn = "bookId")
  val chapters: List<ChapterEntity>,
)

@Dao
interface BookDao {
  @Transaction
  @Query("SELECT * FROM books ORDER BY createdAt DESC")
  fun observeBooks(): Flow<List<BookWithChapters>>

  @Transaction
  @Query("SELECT * FROM books WHERE id = :bookId LIMIT 1")
  fun observeBook(bookId: String): Flow<BookWithChapters?>

  @Query("SELECT * FROM books WHERE id = :bookId LIMIT 1")
  suspend fun getBook(bookId: String): BookEntity?

  @Query("SELECT * FROM chapters WHERE id = :chapterId LIMIT 1")
  suspend fun getChapter(chapterId: String): ChapterEntity?

  @Query("SELECT * FROM chapters WHERE bookId = :bookId ORDER BY indexInBook ASC")
  suspend fun getChaptersForBook(bookId: String): List<ChapterEntity>

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun upsertBook(book: BookEntity)

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun upsertChapters(chapters: List<ChapterEntity>)

  @Query("DELETE FROM chapters WHERE bookId = :bookId")
  suspend fun deleteChapters(bookId: String)

  @Query("DELETE FROM books WHERE id = :bookId")
  suspend fun deleteBook(bookId: String)

  @Query("UPDATE books SET lastPositionMs = :positionMs WHERE id = :bookId")
  suspend fun updateLegacyLastPosition(bookId: String, positionMs: Long)

  @Query(
    """
    UPDATE books
    SET lastChapterIndex = :chapterIndex,
      lastPositionMs = :globalPositionMs,
      lastOpenedAt = :openedAt,
      updatedAt = :openedAt
    WHERE id = :bookId
    """,
  )
  suspend fun updateLastPosition(
    bookId: String,
    chapterIndex: Int,
    globalPositionMs: Long,
    openedAt: Long,
  )

  @Query(
    """
    UPDATE chapters
    SET playedPositionMs = :positionMs,
      updatedAt = :updatedAt
    WHERE bookId = :bookId AND indexInBook = :chapterIndex
    """,
  )
  suspend fun updateChapterPlayedPosition(
    bookId: String,
    chapterIndex: Int,
    positionMs: Long,
    updatedAt: Long,
  )

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun upsertScriptSegments(segments: List<ScriptSegmentEntity>)

  @Query("DELETE FROM script_segments WHERE bookId = :bookId")
  suspend fun deleteScriptSegments(bookId: String)

  @Query("DELETE FROM script_segments WHERE chapterId = :chapterId")
  suspend fun deleteScriptSegmentsForChapter(chapterId: String)

  @Query("SELECT * FROM script_segments WHERE bookId = :bookId AND chapterIndex = :chapterIndex ORDER BY startMs ASC")
  suspend fun getScriptSegmentsForChapter(bookId: String, chapterIndex: Int): List<ScriptSegmentEntity>
}

@Dao
interface ImportJobDao {
  @Query("SELECT * FROM import_jobs ORDER BY createdAt DESC")
  fun observeJobs(): Flow<List<ImportJobEntity>>

  @Query("SELECT * FROM import_jobs WHERE status NOT IN ('READY', 'FAILED') ORDER BY createdAt DESC")
  fun observeActiveJobs(): Flow<List<ImportJobEntity>>

  @Query("SELECT COUNT(*) FROM import_jobs WHERE status IN ('READY', 'FAILED')")
  fun observeFinishedJobCount(): Flow<Int>

  @Query("SELECT * FROM import_jobs WHERE id = :jobId LIMIT 1")
  fun observeJob(jobId: String): Flow<ImportJobEntity?>

  @Query("SELECT * FROM import_jobs WHERE id = :jobId LIMIT 1")
  suspend fun getJob(jobId: String): ImportJobEntity?

  @Query("SELECT * FROM import_jobs WHERE bookId = :bookId AND jobKind = 'book_import' ORDER BY createdAt DESC LIMIT 1")
  suspend fun getBookImportJob(bookId: String): ImportJobEntity?

  @Query("SELECT * FROM import_jobs WHERE normalizedUrl = :normalizedUrl AND status NOT IN ('READY', 'FAILED') ORDER BY createdAt DESC LIMIT 1")
  suspend fun getActiveJobByNormalizedUrl(normalizedUrl: String): ImportJobEntity?

  @Query("SELECT * FROM import_jobs WHERE chapterId = :chapterId AND status NOT IN ('READY', 'FAILED') ORDER BY createdAt DESC LIMIT 1")
  suspend fun getActiveJobByChapterId(chapterId: String): ImportJobEntity?

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun upsert(job: ImportJobEntity)

  @Query("DELETE FROM import_jobs WHERE id = :jobId")
  suspend fun deleteById(jobId: String)

  @Query("DELETE FROM import_jobs WHERE bookId = :bookId")
  suspend fun deleteByBookId(bookId: String)

  @Query("DELETE FROM import_jobs WHERE status IN ('READY', 'FAILED')")
  suspend fun deleteFinishedJobs()
}

@Database(
  entities = [BookEntity::class, ChapterEntity::class, ScriptSegmentEntity::class, ImportJobEntity::class],
  version = 3,
  exportSchema = false,
)
abstract class NovaDatabase : RoomDatabase() {
  abstract fun bookDao(): BookDao
  abstract fun importJobDao(): ImportJobDao
}
