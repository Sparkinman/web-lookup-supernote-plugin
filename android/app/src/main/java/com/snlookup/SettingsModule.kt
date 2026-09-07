package com.snlookup

import android.os.Environment
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.security.MessageDigest

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
   * A file's size and the MD5 of its contents.
   *
   * A digest the device made carries `source_size` and a 32-hex
   * `unique_identifier` in its metadata, and the pair is how Supernote
   * identifies a file: size plus content hash, not path. Hashed in a stream so
   * an eighty-megabyte book does not have to be held in memory at once.
   */
  @ReactMethod
  fun fileInfo(path: String, promise: Promise) {
    try {
      val file = File(path)
      if (!file.isFile) {
        promise.reject("NO_FILE", "There is no file at $path")
        return
      }
      val digest = MessageDigest.getInstance("MD5")
      val started = System.currentTimeMillis()
      file.inputStream().use { stream ->
        val buffer = ByteArray(1 shl 16)
        while (true) {
          val read = stream.read(buffer)
          if (read <= 0) break
          digest.update(buffer, 0, read)
        }
      }
      val md5 = digest.digest().joinToString("") { "%02x".format(it) }
      val took = System.currentTimeMillis() - started
      LogFile.append("fileInfo: ${file.length()} bytes, md5 $md5, ${took}ms — $path")
      promise.resolve(
          Arguments.createMap().apply {
            putString("md5", md5)
            putDouble("size", file.length().toDouble())
          })
    } catch (t: Throwable) {
      LogFile.append("fileInfo: failed $t")
      promise.reject("FILE_INFO_FAILED", t.message ?: t.toString(), t)
    }
  }

  companion object {
    private const val DIR = "Document/LookUp"
    private const val FILE = "settings.json"
  }
}
