package com.xiaoke.nova

import android.content.Context

import androidx.room.Room

import com.google.gson.Gson
import com.xiaoke.nova.data.local.NovaDatabase
import com.xiaoke.nova.data.remote.NovaApi
import com.xiaoke.nova.data.repository.BookRepository
import com.xiaoke.nova.data.repository.ImportRepository
import com.xiaoke.nova.playback.PlaybackManager

import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory

class NovaContainer(context: Context) {
  private val appContext = context.applicationContext

  val gson: Gson = Gson()

  val database: NovaDatabase =
    Room.databaseBuilder(appContext, NovaDatabase::class.java, "nova.db")
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
  val bookRepository = BookRepository(database.bookDao(), database.importJobDao())
  val importRepository = ImportRepository(appContext, api, database.importJobDao())
  val playbackManager = PlaybackManager(appContext, database.bookDao())
}
