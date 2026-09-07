package com.snlookup

import android.content.Intent
import android.net.Uri
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Fetching pages, and handing them off when fetching is not enough.
 *
 * The plugin cannot render web content itself — PluginHost is a privileged
 * process and Android refuses to create a WebView in one — so a page is either
 * fetched as text and drawn with ordinary React Native views, or opened in the
 * firmware's own viewer, which runs in a process without that restriction.
 */
class WebModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "LookUpWeb"

  /**
   * Single-threaded rather than a pool: the panel shows one page at a time, and
   * serialising requests means a slow fetch cannot be overtaken by the next one
   * and render stale content over it.
   */
  private val executor = Executors.newSingleThreadExecutor()

  /**
   * GET a URL and resolve its body as text.
   *
   * Redirects are followed by hand because HttpURLConnection silently refuses to
   * follow one that changes protocol, and http→https is the common case for the
   * search engines this talks to.
   */
  @ReactMethod
  fun get(url: String, promise: Promise) {
    executor.execute {
      var connection: HttpURLConnection? = null
      try {
        var current = url
        var redirects = 0
        while (true) {
          // The agent is logged with every request on purpose: a native change
          // does not take effect while the host still has the old dex loaded,
          // and the only way to tell from outside is to have the running code
          // say what it is.
          LogFile.append("fetch: GET $current (as $USER_AGENT)")
          connection?.disconnect()
          connection = (URL(current).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = TIMEOUT_MS
            readTimeout = TIMEOUT_MS
            instanceFollowRedirects = false
            // Announce what this actually is. Claiming to be Chrome gets
            // DuckDuckGo's bot-check page instead of results — verified: a
            // browser user agent returns zero result links, a text-browser one
            // returns all of them. This is a text client, so it says so.
            setRequestProperty("User-Agent", USER_AGENT)
            setRequestProperty("Accept-Language", "en")
          }

          val status = connection!!.responseCode
          if (status !in 300..399 || redirects >= MAX_REDIRECTS) {
            break
          }
          val location = connection!!.getHeaderField("Location")
          if (location.isNullOrBlank()) {
            break
          }
          current = URL(URL(current), location).toString()
          redirects++
        }

        val live = connection!!
        val status = live.responseCode
        val stream = if (status >= 400) live.errorStream else live.inputStream
        val body =
            stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty().let {
              // A runaway page would otherwise be parsed and rendered in full on
              // a device with very little memory to spare.
              if (it.length > MAX_BODY) it.substring(0, MAX_BODY) else it
            }

        LogFile.append("fetch: $status ${body.length} bytes from $current")
        promise.resolve(
            Arguments.createMap().apply {
              putInt("status", status)
              putString("finalUrl", current)
              putString("contentType", live.contentType ?: "")
              putString("body", body)
            })
      } catch (t: Throwable) {
        LogFile.append("fetch: failed ${t}")
        promise.reject("FETCH_FAILED", t.message ?: t.toString(), t)
      } finally {
        connection?.disconnect()
      }
    }
  }

  /**
   * Open a URL in whatever app handles it — on this device, the built-in viewer.
   *
   * NEW_TASK is required: the plugin has no activity of its own to start it
   * from, so without it the launch is refused.
   */
  @ReactMethod
  fun openExternally(url: String, promise: Promise) {
    try {
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      reactContext.startActivity(intent)
      LogFile.append("viewer: opened $url")
      promise.resolve(true)
    } catch (t: Throwable) {
      LogFile.append("viewer: could not open $url ($t)")
      promise.reject("OPEN_FAILED", t.message ?: t.toString(), t)
    }
  }

  companion object {
    private const val TIMEOUT_MS = 20000
    private const val MAX_REDIRECTS = 5
    private const val MAX_BODY = 1_500_000
    private const val USER_AGENT = "Lynx/2.8.9rel.1 libwww-FM/2.14"
  }
}
