package com.xiaoke.nova

import android.content.Context

import androidx.room.Room
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

import com.google.gson.Gson
import com.xiaoke.nova.data.local.NovaDatabase
import com.xiaoke.nova.data.remote.NovaApi
import com.xiaoke.nova.data.repository.BookRepository
import com.xiaoke.nova.data.repository.ImportRepository
import com.xiaoke.nova.playback.PlaybackManager
import com.xiaoke.nova.voice.VoiceCommandManager

import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory

class NovaContainer(context: Context) {
  private val appContext = context.applicationContext

  val gson: Gson = Gson()

  val database: NovaDatabase =
    Room.databaseBuilder(appContext, NovaDatabase::class.java, "nova.db")
      .addMigrations(MIGRATION_1_2, MIGRATION_2_3)
      .fallbackToDestructiveMigration()
      .build()

  private val okHttpClient: OkHttpClient =
    OkHttpClient.Builder()
      .addInterceptor(
        HttpLoggingInterceptor().apply {
          level = HttpLoggingInterceptor.Level.BASIC
        },
      )
      .build()

  private val retrofit: Retrofit =
    Retrofit.Builder()
      .baseUrl(BuildConfig.API_BASE_URL)
      .addConverterFactory(GsonConverterFactory.create(gson))
      .client(okHttpClient)
      .build()

  val api: NovaApi = retrofit.create(NovaApi::class.java)
  val bookRepository = BookRepository(database.bookDao(), database.importJobDao(), gson)
  val importRepository = ImportRepository(appContext, api, database.importJobDao(), bookRepository, gson)
  val playbackManager = PlaybackManager(appContext, database.bookDao())
  val voiceCommandManager = VoiceCommandManager(appContext, api, playbackManager)
}

private val MIGRATION_1_2 =
  object : Migration(1, 2) {
    override fun migrate(db: SupportSQLiteDatabase) {
      db.execSQL(
        """
        CREATE TABLE IF NOT EXISTS `script_segments` (
          `id` TEXT NOT NULL,
          `bookId` TEXT NOT NULL,
          `chapterIndex` INTEGER NOT NULL,
          `startMs` INTEGER NOT NULL,
          `endMs` INTEGER NOT NULL,
          `title` TEXT,
          `text` TEXT NOT NULL,
          `kind` TEXT NOT NULL,
          PRIMARY KEY(`id`)
        )
        """.trimIndent(),
      )
    }
  }

private val MIGRATION_2_3 =
  object : Migration(2, 3) {
    override fun migrate(db: SupportSQLiteDatabase) {
      db.execSQL(
        """
        CREATE TABLE IF NOT EXISTS `books_new` (
          `id` TEXT NOT NULL,
          `title` TEXT NOT NULL,
          `description` TEXT,
          `kind` TEXT NOT NULL,
          `sourceType` TEXT NOT NULL,
          `sourceUri` TEXT NOT NULL,
          `sourceRootUrl` TEXT NOT NULL,
          `language` TEXT NOT NULL,
          `status` TEXT NOT NULL,
          `coverPath` TEXT,
          `chapterCount` INTEGER NOT NULL,
          `readyChapterCount` INTEGER NOT NULL,
          `failedChapterCount` INTEGER NOT NULL,
          `durationMs` INTEGER NOT NULL,
          `localPackageDir` TEXT NOT NULL,
          `lastChapterIndex` INTEGER NOT NULL,
          `lastPositionMs` INTEGER NOT NULL,
          `lastOpenedAt` INTEGER,
          `createdAt` INTEGER NOT NULL,
          `updatedAt` INTEGER NOT NULL,
          PRIMARY KEY(`id`)
        )
        """.trimIndent(),
      )
      db.execSQL(
        """
        INSERT INTO `books_new` (
          `id`, `title`, `description`, `kind`, `sourceType`, `sourceUri`, `sourceRootUrl`,
          `language`, `status`, `coverPath`, `chapterCount`, `readyChapterCount`,
          `failedChapterCount`, `durationMs`, `localPackageDir`, `lastChapterIndex`,
          `lastPositionMs`, `lastOpenedAt`, `createdAt`, `updatedAt`
        )
        SELECT
          `id`, `title`, NULL, 'single_article', `sourceType`, `sourceUri`, `sourceUri`,
          `language`, `status`, `coverPath`,
          (SELECT COUNT(*) FROM `chapters` WHERE `chapters`.`bookId` = `books`.`id`),
          (SELECT COUNT(*) FROM `chapters` WHERE `chapters`.`bookId` = `books`.`id`),
          0, `durationMs`, `localPackageDir`, 0, `lastPositionMs`, NULL, `createdAt`, `createdAt`
        FROM `books`
        """.trimIndent(),
      )

      db.execSQL(
        """
        CREATE TABLE IF NOT EXISTS `chapters_new` (
          `id` TEXT NOT NULL,
          `bookId` TEXT NOT NULL,
          `indexInBook` INTEGER NOT NULL,
          `title` TEXT NOT NULL,
          `sourceUrl` TEXT NOT NULL,
          `status` TEXT NOT NULL,
          `progress` INTEGER NOT NULL,
          `audioPath` TEXT,
          `subtitlePath` TEXT,
          `scriptPath` TEXT,
          `durationMs` INTEGER NOT NULL,
          `playedPositionMs` INTEGER NOT NULL,
          `retryCount` INTEGER NOT NULL,
          `maxRetries` INTEGER NOT NULL,
          `nextRetryAt` INTEGER,
          `errorMessage` TEXT,
          `remoteChapterJobId` TEXT,
          `createdAt` INTEGER NOT NULL,
          `updatedAt` INTEGER NOT NULL,
          `completedAt` INTEGER,
          PRIMARY KEY(`id`)
        )
        """.trimIndent(),
      )
      db.execSQL(
        """
        INSERT INTO `chapters_new` (
          `id`, `bookId`, `indexInBook`, `title`, `sourceUrl`, `status`, `progress`,
          `audioPath`, `subtitlePath`, `scriptPath`, `durationMs`, `playedPositionMs`,
          `retryCount`, `maxRetries`, `nextRetryAt`, `errorMessage`, `remoteChapterJobId`,
          `createdAt`, `updatedAt`, `completedAt`
        )
        SELECT
          `id`, `bookId`, `indexInBook`, `title`,
          COALESCE((SELECT `sourceUri` FROM `books` WHERE `books`.`id` = `chapters`.`bookId`), ''),
          'READY', 100, `audioPath`, `subtitlePath`, NULL, `durationMs`, 0,
          0, 2, NULL, NULL, NULL,
          COALESCE((SELECT `createdAt` FROM `books` WHERE `books`.`id` = `chapters`.`bookId`), 0),
          COALESCE((SELECT `createdAt` FROM `books` WHERE `books`.`id` = `chapters`.`bookId`), 0),
          COALESCE((SELECT `createdAt` FROM `books` WHERE `books`.`id` = `chapters`.`bookId`), 0)
        FROM `chapters`
        """.trimIndent(),
      )

      db.execSQL(
        """
        CREATE TABLE IF NOT EXISTS `script_segments_new` (
          `id` TEXT NOT NULL,
          `bookId` TEXT NOT NULL,
          `chapterId` TEXT NOT NULL,
          `chapterIndex` INTEGER NOT NULL,
          `startMs` INTEGER NOT NULL,
          `endMs` INTEGER NOT NULL,
          `title` TEXT,
          `text` TEXT NOT NULL,
          `kind` TEXT NOT NULL,
          PRIMARY KEY(`id`)
        )
        """.trimIndent(),
      )
      db.execSQL(
        """
        INSERT INTO `script_segments_new` (
          `id`, `bookId`, `chapterId`, `chapterIndex`, `startMs`, `endMs`, `title`, `text`, `kind`
        )
        SELECT
          `id`, `bookId`,
          COALESCE(
            (SELECT `id` FROM `chapters` WHERE `chapters`.`bookId` = `script_segments`.`bookId` AND `chapters`.`indexInBook` = `script_segments`.`chapterIndex` LIMIT 1),
            `bookId` || '-' || `chapterIndex`
          ),
          `chapterIndex`, `startMs`, `endMs`, `title`, `text`, `kind`
        FROM `script_segments`
        """.trimIndent(),
      )

      db.execSQL(
        """
        CREATE TABLE IF NOT EXISTS `import_jobs_new` (
          `id` TEXT NOT NULL,
          `jobKind` TEXT NOT NULL,
          `remoteJobId` TEXT NOT NULL,
          `bookId` TEXT,
          `chapterId` TEXT,
          `normalizedUrl` TEXT NOT NULL,
          `status` TEXT NOT NULL,
          `progress` INTEGER NOT NULL,
          `retryCount` INTEGER NOT NULL,
          `maxRetries` INTEGER NOT NULL,
          `nextRetryAt` INTEGER,
          `errorMessage` TEXT,
          `createdAt` INTEGER NOT NULL,
          `updatedAt` INTEGER NOT NULL,
          PRIMARY KEY(`id`)
        )
        """.trimIndent(),
      )
      db.execSQL(
        """
        INSERT INTO `import_jobs_new` (
          `id`, `jobKind`, `remoteJobId`, `bookId`, `chapterId`, `normalizedUrl`, `status`,
          `progress`, `retryCount`, `maxRetries`, `nextRetryAt`, `errorMessage`, `createdAt`, `updatedAt`
        )
        SELECT
          `id`, 'single_url', `remoteJobId`, `bookId`, NULL, `normalizedUrl`, `status`,
          `progress`, 0, 2, NULL, `errorMessage`, `createdAt`, `updatedAt`
        FROM `import_jobs`
        """.trimIndent(),
      )

      db.execSQL("DROP TABLE `books`")
      db.execSQL("DROP TABLE `chapters`")
      db.execSQL("DROP TABLE `script_segments`")
      db.execSQL("DROP TABLE `import_jobs`")
      db.execSQL("ALTER TABLE `books_new` RENAME TO `books`")
      db.execSQL("ALTER TABLE `chapters_new` RENAME TO `chapters`")
      db.execSQL("ALTER TABLE `script_segments_new` RENAME TO `script_segments`")
      db.execSQL("ALTER TABLE `import_jobs_new` RENAME TO `import_jobs`")
    }
  }
