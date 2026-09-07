package com.snlookup

import android.os.Build

/**
 * Process-level setup that has to happen before React renders anything.
 *
 * Runs from the ReactPackage, which is constructed while the bridge is being
 * built, so the crash handler is in place before any of the plugin's own code
 * has had a chance to fail.
 */
object Bootstrap {

  private var done = false

  @Synchronized
  fun install() {
    if (done) {
      // Worth a line: a missing bootstrap entry would otherwise be ambiguous
      // between "never ran" and "ran in an earlier React context".
      LogFile.append("bootstrap: already installed in this process")
      return
    }
    done = true
    installCrashHandler()
    LogFile.append("bootstrap: Android API ${Build.VERSION.SDK_INT}, process ${android.os.Process.myPid()}")
  }

  /**
   * Record native crashes in the log before the process goes.
   *
   * An exception thrown while a native view is being constructed never reaches
   * a React error boundary or the JS global handler — the process simply dies,
   * which from the outside is indistinguishable from the plugin view closing
   * normally. Writing the stack trace here is the only way to see it without a
   * cable attached.
   */
  private fun installCrashHandler() {
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, error ->
      LogFile.append("NATIVE CRASH on ${thread.name}: ${error}")
      LogFile.append(error.stackTraceToString())
      // Still hand it on: swallowing it would leave the process in a worse
      // state than the crash it was already in.
      previous?.uncaughtException(thread, error)
    }
  }
}
