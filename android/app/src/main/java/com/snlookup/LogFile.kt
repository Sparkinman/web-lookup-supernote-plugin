package com.snlookup

import android.os.Environment
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The one place that touches log.txt.
 *
 * Shared between the JS-facing module and the crash handler, which has to be
 * able to write from a dying thread without going anywhere near the React
 * bridge — by the time an uncaught exception reaches it, JS may already be gone.
 */
object LogFile {

  private const val LOG_DIR = "Document/LookUp"
  private const val LOG_FILE = "log.txt"
  private const val MAX_BYTES = 512 * 1024

  fun path(): File =
      File(File(Environment.getExternalStorageDirectory(), LOG_DIR), LOG_FILE)

  /**
   * Append one stamped line, opening and closing the file each time.
   *
   * Synchronized because the crash handler can fire on any thread while the
   * bridge is mid-write, and interleaved appends would corrupt the line that
   * matters most.
   */
  @Synchronized
  fun append(line: String) {
    try {
      val file = path()
      val dir = file.parentFile ?: return
      if (!dir.exists() && !dir.mkdirs()) {
        return
      }
      if (file.exists() && file.length() > MAX_BYTES) {
        file.writeText("(log truncated at $MAX_BYTES bytes)\n", Charsets.UTF_8)
      }
      file.appendText("${stamp()} $line\n", Charsets.UTF_8)
    } catch (e: Exception) {
      // Nothing useful to do — a logger that throws would take down the run it
      // is trying to describe.
    }
  }

  fun clear(): Boolean {
    val file = path()
    return !file.exists() || file.delete()
  }

  private fun stamp(): String =
      SimpleDateFormat("HH:mm:ss.SSS", Locale.US).format(Date())
}
