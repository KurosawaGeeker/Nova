package com.xiaoke.nova.playback

import java.io.File

data class SubtitleCue(
  val startMs: Long,
  val endMs: Long,
  val text: String,
)

object SubtitleParser {
  fun parse(file: File): List<SubtitleCue> {
    if (!file.exists()) {
      return emptyList()
    }

    val lines = file.readLines()
    val cues = mutableListOf<SubtitleCue>()
    var index = 0

    while (index < lines.size) {
      val line = lines[index].trim()
      if (line.isBlank() || line == "WEBVTT" || line.all(Char::isDigit)) {
        index += 1
        continue
      }

      if (!line.contains("-->")) {
        index += 1
        continue
      }

      val parts = line.split("-->").map(String::trim)
      if (parts.size != 2) {
        index += 1
        continue
      }

      val start = parseTimestamp(parts[0])
      val end = parseTimestamp(parts[1])
      index += 1

      val textLines = mutableListOf<String>()
      while (index < lines.size && lines[index].isNotBlank()) {
        textLines += lines[index].trim()
        index += 1
      }

      cues += SubtitleCue(
        startMs = start,
        endMs = end,
        text = textLines.joinToString(" "),
      )
    }

    return cues
  }

  private fun parseTimestamp(value: String): Long {
    val parts = value.split(":", ".")
    return if (parts.size == 4) {
      val hours = parts[0].toLong()
      val minutes = parts[1].toLong()
      val seconds = parts[2].toLong()
      val millis = parts[3].toLong()
      (((hours * 60 + minutes) * 60) + seconds) * 1000 + millis
    } else {
      0L
    }
  }
}
