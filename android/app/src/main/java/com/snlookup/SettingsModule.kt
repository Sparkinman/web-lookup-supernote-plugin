package com.snlookup

import android.os.Environment
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

/**
 * Keeps the user's preferences between runs.
 *
 * Written to Document/LookUp/ rather than the plugin's private directory: that
 * directory is wiped when a plugin is updated or reinstalled, which on this
 * device happens every time a new build is sideloaded. Settings that vanish on
 * each update are worse than no settings at all.
 *
 * sn-plugin-lib has no general file I/O — PluginFileAPI is note-specific — so
 * this exists for what looks like it should be one SDK call.
 */
class SettingsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "LookUpSettings"

  private fun file(): File =
      File(File(Environment.getExternalStorageDirectory(), DIR), FILE)

  /** Resolves the stored JSON, or null when nothing has been saved yet. */
  @ReactMethod
  fun read(promise: Promise) {
    try {
      val file = file()
      if (!file.exists() || !file.canRead()) {
        promise.resolve(null)
        return
      }
      promise.resolve(file.readText(Charsets.UTF_8))
    } catch (t: Throwable) {
      // Reported rather than resolved as null, which would be indistinguishable
      // from "nothing saved" and would silently reset the user's choices.
      LogFile.append("settings: read failed $t")
      promise.reject("READ_FAILED", t.message ?: t.toString(), t)
    }
  }

  @ReactMethod
  fun write(contents: String, promise: Promise) {
    try {
      val file = file()
      val dir = file.parentFile
      if (dir != null && !dir.exists() && !dir.mkdirs()) {
        promise.reject("WRITE_FAILED", "Could not create ${dir.absolutePath}")
        return
      }
      file.writeText(contents, Charsets.UTF_8)
      LogFile.append("settings: saved ${file.absolutePath}")
      promise.resolve(file.absolutePath)
    } catch (t: Throwable) {
      LogFile.append("settings: write failed $t")
      promise.reject("WRITE_FAILED", t.message ?: t.toString(), t)
    }
  }

  /**
   * The immediate subfolders of a path, relative to shared storage.
   *
   * One level at a time rather than a tree: a device holds thousands of
   * folders, the panel is small, and a step-wise walk costs one call per
   * screen. An empty path means the root of internal storage.
   */
  @ReactMethod
  fun listDirs(relativePath: String, promise: Promise) {
    try {
      val root = Environment.getExternalStorageDirectory()
      val dir = if (relativePath.isBlank()) root else File(root, relativePath)
      val out = Arguments.createArray()
      if (!dir.isDirectory) {
        promise.resolve(out)
        return
      }
      dir.listFiles()
          ?.filter { it.isDirectory && !it.isHidden }
          ?.sortedBy { it.name.lowercase() }
          ?.forEach { out.pushString(it.name) }
      promise.resolve(out)
    } catch (t: Throwable) {
      LogFile.append("settings: listDirs failed $t")
      promise.reject("LIST_DIRS_FAILED", t.message ?: t.toString(), t)
    }
  }

  /** Create a folder the user has named, so a new one can be picked. */
  @ReactMethod
  fun makeDirs(relativePath: String, promise: Promise) {
    try {
      val dir = File(Environment.getExternalStorageDirectory(), relativePath)
      if (dir.isDirectory || dir.mkdirs()) {
        promise.resolve(dir.absolutePath)
      } else {
        promise.reject("MKDIR_FAILED", "Could not create ${dir.absolutePath}")
      }
    } catch (t: Throwable) {
      promise.reject("MKDIR_FAILED", t.message ?: t.toString(), t)
    }
  }

  /**
   * Add one excerpt to the queue of things waiting to reach the digest note.
   *
   * Needed because a plugin may not touch a note file at all while a book is in
   * front: every PluginFileAPI call, reads included, comes back "This app is
   * not allowed to use this API" (code 102). An excerpt taken from a book
   * therefore cannot be written when it is taken, so it is parked here and
   * written the next time the plugin runs with a note open.
   *
   * One JSON object per line, appended and closed immediately, so a crash costs
   * at most the entry being written rather than the whole queue.
   */
  @ReactMethod
  fun queueAppend(entryJson: String, promise: Promise) {
    try {
      val file = queueFile()
      val dir = file.parentFile
      if (dir != null && !dir.exists() && !dir.mkdirs()) {
        promise.reject("QUEUE_FAILED", "Could not create ${dir.absolutePath}")
        return
      }
      file.appendText(entryJson.replace("\n", " ") + "\n", Charsets.UTF_8)
      LogFile.append("digest: queued an excerpt in ${file.absolutePath}")
      promise.resolve(file.absolutePath)
    } catch (t: Throwable) {
      LogFile.append("digest: queue failed $t")
      promise.reject("QUEUE_FAILED", t.message ?: t.toString(), t)
    }
  }

  /** Everything waiting, oldest first, one JSON object per line. */
  @ReactMethod
  fun queueRead(promise: Promise) {
    try {
      val file = queueFile()
      if (!file.exists() || !file.canRead()) {
        promise.resolve("")
        return
      }
      promise.resolve(file.readText(Charsets.UTF_8))
    } catch (t: Throwable) {
      LogFile.append("digest: queue read failed $t")
      promise.reject("QUEUE_READ_FAILED", t.message ?: t.toString(), t)
    }
  }

  /**
   * Empty the queue.
   *
   * Truncated rather than deleted: removing a file needs FILE:DELETE, which
   * this plugin does not ask for.
   */
  @ReactMethod
  fun queueClear(promise: Promise) {
    try {
      val file = queueFile()
      if (file.exists()) {
        file.writeText("", Charsets.UTF_8)
      }
      promise.resolve(true)
    } catch (t: Throwable) {
      promise.reject("QUEUE_CLEAR_FAILED", t.message ?: t.toString(), t)
    }
  }

  private fun queueFile(): File =
      File(File(Environment.getExternalStorageDirectory(), DIR), QUEUE)

  companion object {
    private const val DIR = "Document/LookUp"
    private const val FILE = "settings.json"
    private const val QUEUE = "pending-digest.jsonl"
  }
}
