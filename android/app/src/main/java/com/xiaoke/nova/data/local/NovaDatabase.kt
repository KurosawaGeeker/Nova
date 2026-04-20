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
  val sourceType: String,
  val sourceUri: String,
  val language: String,
  val status: String,
  val coverPath: String?,
  val durationMs: Long,
  val localPackageDir: String,
  val lastPositionMs: Long,
  val createdAt: Long,
)

@Entity(tableName = "chapters", primaryKeys = ["id"])
data class ChapterEntity(
  val id: String,
  val bookId: String,
  val indexInBook: Int,
  val title: String,
  val audioPath: String,
  val subtitlePath: String,
  val durationMs: Long,
)

@Entity(tableName = "import_jobs")
data class ImportJobEntity(
  @PrimaryKey val id: String,
  val remoteJobId: String,
  val bookId: String?,
  val normalizedUrl: String,
  val status: String,
  val progress: Int,
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

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun upsertBook(book: BookEntity)

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun upsertChapters(chapters: List<ChapterEntity>)

  @Query("DELETE FROM chapters WHERE bookId = :bookId")
  suspend fun deleteChapters(bookId: String)

  @Query("DELETE FROM books WHERE id = :bookId")
  suspend fun deleteBook(bookId: String)

  @Query("UPDATE books SET lastPositionMs = :positionMs WHERE id = :bookId")
  suspend fun updateLastPosition(bookId: String, positionMs: Long)
}

@Dao
interface ImportJobDao {
  @Query("SELECT * FROM import_jobs ORDER BY createdAt DESC")
  fun observeJobs(): Flow<List<ImportJobEntity>>

  @Query("SELECT * FROM import_jobs WHERE id = :jobId LIMIT 1")
  fun observeJob(jobId: String): Flow<ImportJobEntity?>

  @Query("SELECT * FROM import_jobs WHERE id = :jobId LIMIT 1")
  suspend fun getJob(jobId: String): ImportJobEntity?

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun upsert(job: ImportJobEntity)

  @Query("DELETE FROM import_jobs WHERE bookId = :bookId")
  suspend fun deleteByBookId(bookId: String)
}

@Database(
  entities = [BookEntity::class, ChapterEntity::class, ImportJobEntity::class],
  version = 1,
  exportSchema = false,
)
abstract class NovaDatabase : RoomDatabase() {
  abstract fun bookDao(): BookDao
  abstract fun importJobDao(): ImportJobDao
}
