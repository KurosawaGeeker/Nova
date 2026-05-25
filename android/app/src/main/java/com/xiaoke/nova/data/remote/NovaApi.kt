package com.xiaoke.nova.data.remote

import okhttp3.ResponseBody
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Streaming
import retrofit2.http.Url

data class SubmitUrlRequest(
  val url: String,
)

data class SubmitUrlResponse(
  val jobId: String,
  val normalizedUrl: String,
)

data class RemoteImportJobResponse(
  val status: String,
  val progress: Int,
  val bookId: String?,
  val downloadUrl: String?,
  val errorMessage: String?,
)

data class DiscoverBookRequest(
  val url: String,
)

data class DiscoveredChapterResponse(
  val index: Int,
  val title: String,
  val url: String,
  val selectedByDefault: Boolean,
  val confidence: Double,
)

data class BookDiscoveryResponse(
  val discoveryId: String,
  val sourceUrl: String,
  val candidateBookTitle: String,
  val confidence: Double,
  val discoveryMode: String,
  val warnings: List<String>,
  val chapters: List<DiscoveredChapterResponse>,
)

data class FilePreviewRequest(
  val fileName: String,
  val fileType: String?,
  val contentBase64: String,
)

data class FilePreviewChapterResponse(
  val id: String,
  val title: String,
  val startOffset: Int,
  val endOffset: Int,
  val characterCount: Int,
  val estimatedMinutes: Int,
  val previewText: String,
)

data class FilePreviewResponse(
  val fileName: String,
  val fileType: String,
  val status: String,
  val detectedTitle: String?,
  val language: String,
  val chapteringMode: String,
  val confidence: Double,
  val warnings: List<String>,
  val chapters: List<FilePreviewChapterResponse>,
)

data class CreateBookChapterRequest(
  val index: Int,
  val title: String,
  val url: String,
)

data class CreateBookRequest(
  val discoveryId: String?,
  val title: String,
  val sourceRootUrl: String,
  val chapters: List<CreateBookChapterRequest>,
)

data class CreatedBookChapterResponse(
  val chapterId: String,
  val index: Int,
  val status: String,
)

data class CreateBookResponse(
  val bookId: String,
  val jobId: String,
  val chapterJobs: List<CreatedBookChapterResponse>,
)

data class RemoteBookChapterResponse(
  val chapterId: String,
  val index: Int,
  val title: String,
  val status: String,
  val progress: Int,
  val durationMs: Long,
  val retryCount: Int,
  val maxRetries: Int,
  val nextRetryAt: String?,
  val errorMessage: String?,
  val downloadUrl: String?,
)

data class RemoteBookStatusResponse(
  val bookId: String,
  val title: String,
  val status: String,
  val chapterCount: Int,
  val readyChapterCount: Int,
  val failedChapterCount: Int,
  val durationMs: Long,
  val chapters: List<RemoteBookChapterResponse>,
)

data class VoiceCommandSegmentDto(
  val id: String,
  val chapterId: String?,
  val chapterIndex: Int,
  val startMs: Long,
  val endMs: Long,
  val title: String?,
  val text: String,
  val kind: String,
)

data class VoiceCommandRequest(
  val audioBase64: String?,
  val mimeType: String?,
  val debugTranscript: String?,
  val bookTitle: String,
  val chapterTitle: String,
  val chapterIndex: Int,
  val positionMs: Long,
  val currentSegment: VoiceCommandSegmentDto?,
  val previousSegment: VoiceCommandSegmentDto?,
  val nextSegments: List<VoiceCommandSegmentDto>,
)

data class VoiceCommandResponse(
  val intent: String,
  val transcript: String?,
  val answerText: String?,
  val answerAudioUrl: String?,
  val replaySegment: VoiceCommandSegmentDto?,
  val errorMessage: String?,
)

interface NovaApi {
  @POST("v1/imports/url")
  suspend fun submitUrl(@Body request: SubmitUrlRequest): SubmitUrlResponse

  @POST("v1/books/discover")
  suspend fun discoverBook(@Body request: DiscoverBookRequest): BookDiscoveryResponse

  @POST("v1/files/preview")
  suspend fun previewFile(@Body request: FilePreviewRequest): Response<FilePreviewResponse>

  @POST("v1/books")
  suspend fun createBook(@Body request: CreateBookRequest): CreateBookResponse

  @GET("v1/books/{bookId}")
  suspend fun getBook(@Path("bookId") bookId: String): RemoteBookStatusResponse

  @GET("v1/imports/{jobId}")
  suspend fun getImportJob(@Path("jobId") jobId: String): RemoteImportJobResponse

  @Streaming
  @GET
  suspend fun downloadPackage(@Url url: String): Response<ResponseBody>

  @POST("v1/voice-commands")
  suspend fun submitVoiceCommand(@Body request: VoiceCommandRequest): VoiceCommandResponse
}
