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
 * Keeps the user's preferences between runs, where only the plugin can see them.
 *
 * These used to be a JSON file in Document/LookUp, which anyone could read off
 * the device over USB. That was tolerable while the settings were a folder name
 * and a label; it stopped being so once they held a Supernote session token,
 * which is as good as the account for as long as it lasts.
 *
 * Preferences rather than a private file. The plugin's own directory is wiped
 * whenever a plugin is updated, which on this device is every sideloaded build,
 * so settings kept there would not survive one -- and signing in again after
 * every install is exactly what a stored session is meant to avoid. This code
 * runs inside PluginHost's process, so these belong to PluginHost and outlive
 * the plugin's own directory, while still being invisible outside the device.
 *
 * sn-plugin-lib has no general file I/O — PluginFileAPI is note-specific — so
 * this exists for what looks like it should be one SDK call.
 */
class SettingsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "LookUpSettings"

  private fun prefs() = reactApplicationContext.getSharedPreferences(PREFS, 0)

  /** The old plaintext file, kept only to be read once and emptied. */
  private fun legacyFile(): File =
      File(File(Environment.getExternalStorageDirectory(), DIR), FILE)

  /** Resolves the stored JSON, or null when nothing has been saved yet. */
  @ReactMethod
  fun read(promise: Promise) {
    try {
      val stored = prefs().getString(KEY, null)
      if (stored != null) {
        promise.resolve(stored)
        return
      }

      // Nothing here yet. An earlier version kept the same JSON in a file on
      // shared storage, so it is taken across rather than lost -- and then
      // emptied, because it holds a session token and has no business being
      // readable over USB. Truncated rather than deleted: removing a file needs
      // FILE:DELETE, which this plugin deliberately does not ask for.
      val old = legacyFile()
      if (!old.exists() || !old.canRead()) {
        promise.resolve(null)
        return
      }
      val text = old.readText(Charsets.UTF_8)
      if (text.isBlank()) {
        promise.resolve(null)
        return
      }
      prefs().edit().putString(KEY, text).apply()
      try {
        old.writeText("", Charsets.UTF_8)
        LogFile.append("settings: moved out of ${old.absolutePath} and emptied it")
      } catch (t: Throwable) {
        LogFile.append("settings: moved in, but could not empty ${old.absolutePath}: $t")
      }
      promise.resolve(text)
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
      prefs().edit().putString(KEY, contents).apply()
      LogFile.append("settings: saved (${contents.length} chars, not on shared storage)")
      promise.resolve("preferences")
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
    private const val PREFS = "look-up-settings"
    private const val KEY = "settings-json"
    private const val DIR = "Document/LookUp"
    private const val FILE = "settings.json"
  }
}
