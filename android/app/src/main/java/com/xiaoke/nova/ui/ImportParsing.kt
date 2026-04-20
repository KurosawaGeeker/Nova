package com.xiaoke.nova.ui

private val UrlRegex = Regex("""https?://[^\s<>"'`]+""", RegexOption.IGNORE_CASE)

fun parseImportedUrls(input: String): List<String> {
  val seen = linkedSetOf<String>()

  UrlRegex.findAll(input).forEach { match ->
    normalizeUrlCandidate(match.value)?.let(seen::add)
  }

  return seen.toList()
}

private fun normalizeUrlCandidate(candidate: String): String? {
  val trimmed = candidate.trim().trimEnd('.', ',', ';', ':', ')', ']', '}', '>', '。', '，', '；', '：')
  return runCatching {
    val parsed = java.net.URL(trimmed)
    if (parsed.protocol == "http" || parsed.protocol == "https") {
      parsed.toString()
    } else {
      null
    }
  }.getOrNull()
}
