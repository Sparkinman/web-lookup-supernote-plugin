package com.snlookup

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Appends diagnostic lines to a file the user can copy off the device.
 *
 * The plugin view is torn down when it crashes, which takes any on-screen error
 * with it, and `adb logcat` needs a cable and USB debugging that are not always
 * available. A file on shared storage survives both: the plugin can be run until
 * it dies and the log read afterwards.
 *
 * Writes to Document/LookUp/ rather than the plugin's private directory
 * precisely because the private directory is not reachable over USB — the point
 * of this file is that it can be dragged off the device.
 *
 * sn-plugin-lib has no general file I/O (PluginFileAPI is note-specific), hence
 * a native module for what looks like it should be one SDK call.
 */
class LogModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName() = NAME


  /**
   * Append one line, stamped with the time.
   *
   * Each call opens, writes and closes. That is more expensive than holding a
   * writer open, and deliberately so: a buffered writer loses whatever is still
   * in the buffer when the process dies, which is exactly the moment this file
   * exists to capture.
   */
  @ReactMethod
  fun append(line: String, promise: Promise) {
    LogFile.append(line)
    promise.resolve(LogFile.path().absolutePath)
  }

  /** Start a new run's section, so one file can hold several attempts. */
  @ReactMethod
  fun startSession(header: String, promise: Promise) {
    append("\n===== $header =====", promise)
  }

  /** Discard the file, for starting a diagnosis from clean. */
  @ReactMethod
  fun clear(promise: Promise) {
    promise.resolve(LogFile.clear())
  }

  /** Where the file is, so the panel can tell the user where to look. */
  @ReactMethod
  fun location(promise: Promise) {
    promise.resolve(LogFile.path().absolutePath)
  }

  companion object {
    const val NAME = "LookUpLog"
  }
}
