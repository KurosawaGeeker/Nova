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

interface NovaApi {
  @POST("v1/imports/url")
  suspend fun submitUrl(@Body request: SubmitUrlRequest): SubmitUrlResponse

  @GET("v1/imports/{jobId}")
  suspend fun getImportJob(@Path("jobId") jobId: String): RemoteImportJobResponse

  @Streaming
  @GET
  suspend fun downloadPackage(@Url url: String): Response<ResponseBody>
}
