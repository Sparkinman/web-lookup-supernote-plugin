package com.snlookup

import android.os.Environment
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

  companion object {
    private const val DIR = "Document/LookUp"
    private const val FILE = "settings.json"
  }
}
