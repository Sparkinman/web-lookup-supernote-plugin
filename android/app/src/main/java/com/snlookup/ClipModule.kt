package com.snlookup

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Environment
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.uimanager.UIManagerModule
import java.io.File
import org.json.JSONArray

/**
 * Draws a clipping as a PNG for the note to link to.
 *
 * The device cannot screenshot a web page — the firmware's viewer is another
 * app in another process — but it does not need to: the plugin fetched the text
 * itself, so the clipping is composed rather than captured. Composing it means
 * each passage can be shown with the address it came from, which a screenshot
 * of a result list does not make clear.
 *
 * A link of type 3 points at one of these files, so tapping in the note opens
 * it in the image viewer. That is what makes the popup work with nothing
 * running to serve it.
 */
class ClipModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "LookUpClip"

  /**
   * Photograph the reader itself, rather than composing a clipping from text.
   *
   * Wanted when the layout is the point — a table, a list, anything whose shape
   * carries meaning that plain passages lose. This captures the plugin's own
   * view, which is the one thing on this device that *can* be captured: the
   * firmware's web viewer runs in another process and is not reachable.
   *
   * Only what is on screen is drawn. A ScrollView renders its visible window
   * and nothing else, which is what "screenshot" ought to mean anyway.
   */
  @ReactMethod
  fun captureView(tag: Int, name: String, folder: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      try {
        val manager = reactApplicationContext.getNativeModule(UIManagerModule::class.java)
        val resolved = manager?.resolveView(tag)
        if (resolved == null || resolved.width <= 0 || resolved.height <= 0) {
          promise.reject("CAPTURE_FAILED", "The reader had nothing laid out to capture")
          return@runOnUiThread
        }

        // Deliberately the view as displayed, scroll position and all. A
        // screenshot is wanted for the times the arrangement on screen is
        // itself the thing worth keeping, and expanding it to the whole
        // scrollable page would quietly turn it into a different feature.
        val view = resolved
        LogFile.append("clip: capturing ${view.width}x${view.height} as displayed")

        val dir = folderOf(folder)
        if (!dir.exists() && !dir.mkdirs()) {
          promise.reject("CAPTURE_FAILED", "Could not create ${dir.absolutePath}")
          return@runOnUiThread
        }

        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        // The view's own background may be transparent, and the image viewer
        // puts a dark ground behind anything with alpha.
        canvas.drawColor(Color.WHITE)
        view.draw(canvas)


        val file = File(dir, if (name.endsWith(".png")) name else "$name.png")
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()

        LogFile.append("clip: captured ${file.absolutePath} (${view.width}x${view.height})")
        promise.resolve(describe(file.absolutePath, view.width, view.height))
      } catch (t: Throwable) {
        LogFile.append("clip: capture failed $t")
        promise.reject("CAPTURE_FAILED", t.message ?: t.toString(), t)
      }
    }
  }

  /**
   * Where images are written, as chosen in settings.
   *
   * A relative folder is taken against shared storage so a setting can be typed
   * as "Document/LookUp/clips" rather than with the emulated-storage prefix,
   * which is not something anyone should have to know. An absolute path is
   * honoured as given, and an empty one falls back to the default rather than
   * writing to the root of the card.
   */
  private fun folderOf(folder: String): File {
    val trimmed = folder.trim().trimEnd('/')
    if (trimmed.isEmpty()) {
      return File(Environment.getExternalStorageDirectory(), CLIP_DIR)
    }
    if (trimmed.startsWith("/")) {
      return File(trimmed)
    }
    return File(Environment.getExternalStorageDirectory(), trimmed)
  }

  /**
   * A drawn file described rather than merely named.
   *
   * The path alone was enough while these images were only ever link targets.
   * A digest page draws one into the note itself, and a picture element scaled
   * past its natural size takes the note app down with it -- so the size has to
   * travel with the path rather than be guessed at the other end.
   */
  private fun describe(path: String, width: Int, height: Int): WritableMap =
      Arguments.createMap().apply {
        putString("path", path)
        putInt("width", width)
        putInt("height", height)
      }

  /** One passage, with where it came from. */
  private data class Section(val heading: String, val url: String, val body: String)

  /**
   * Render a clipping and resolve its absolute path.
   *
   * `sectionsJson` is an array of `{heading, url, body}`. Structure rather than
   * one blob of text: the heading, the address and the passage want different
   * type, and flattening them into a paragraph is what made an earlier version
   * ambiguous about which result said what.
   */
  @ReactMethod
  fun render(
      name: String,
      title: String,
      source: String,
      sectionsJson: String,
      folder: String,
      promise: Promise
  ) {
    try {
      val dir = folderOf(folder)
      if (!dir.exists() && !dir.mkdirs()) {
        promise.reject("CLIP_FAILED", "Could not create ${dir.absolutePath}")
        return
      }

      val sections = parse(sectionsJson)
      val titlePaint = paint(TITLE_SIZE, Typeface.BOLD)
      val sourcePaint = paint(SOURCE_SIZE, Typeface.NORMAL).apply { color = GREY }
      // The title is set lighter than the address above it: the address is the
      // thing that has to be unmistakable, and two bold weights next to each
      // other cancel each other out.
      val headingPaint = paint(HEADING_SIZE, Typeface.NORMAL)
      // Bold, and drawn above the passage rather than under it: the address is
      // the thing that says whether a quote can be trusted, and set in small
      // grey type below the text it was consistently missed.
      val urlPaint = paint(URL_SIZE, Typeface.BOLD)
      val bodyPaint = paint(BODY_SIZE, Typeface.NORMAL)

      val textWidth = (CANVAS_WIDTH - MARGIN * 2).toFloat()

      // Laid out once to measure, then again to draw: the canvas has to be
      // allocated at the right height before anything can be put on it.
      val titleLines = wrap(title, titlePaint, textWidth)
      val sourceLines = wrap(source, sourcePaint, textWidth)
      val laid =
          sections.map {
            Triple(
                wrap(it.heading, headingPaint, textWidth),
                wrap(it.url, urlPaint, textWidth),
                wrap(it.body, bodyPaint, textWidth),
            )
          }

      var height = MARGIN
      height += (titleLines.size * titlePaint.fontSpacing).toInt() + GAP / 2
      height += (sourceLines.size * sourcePaint.fontSpacing).toInt() + GAP
      height += RULE.toInt() + GAP
      for ((heads, urls, bodies) in laid) {
        height += (heads.size * headingPaint.fontSpacing).toInt()
        if (urls.isNotEmpty()) {
          height += GAP / 4 + (urls.size * urlPaint.fontSpacing).toInt()
        }
        if (bodies.isNotEmpty()) {
          height += GAP / 3 + (bodies.size * bodyPaint.fontSpacing).toInt()
        }
        height += SECTION_GAP
      }
      height += MARGIN

      val bitmap =
          Bitmap.createBitmap(
              CANVAS_WIDTH, maxOf(height, MIN_HEIGHT), Bitmap.Config.ARGB_8888)
      val canvas = Canvas(bitmap)
      // White, not transparent: the viewer puts a dark ground behind an image
      // with an alpha channel, which would render black text invisible.
      canvas.drawColor(Color.WHITE)

      var y = MARGIN.toFloat()
      y = draw(canvas, titleLines, titlePaint, y) + GAP / 2
      y = draw(canvas, sourceLines, sourcePaint, y) + GAP
      canvas.drawRect(
          MARGIN.toFloat(),
          y,
          (CANVAS_WIDTH - MARGIN).toFloat(),
          y + RULE,
          paint(1f, Typeface.NORMAL))
      y += RULE + GAP

      for ((index, section) in laid.withIndex()) {
        val (heads, urls, bodies) = section
        if (index > 0) {
          // Passages ran into each other when only white space separated them.
          canvas.drawRect(
              MARGIN.toFloat(),
              y - SECTION_GAP / 2,
              (CANVAS_WIDTH - MARGIN).toFloat(),
              y - SECTION_GAP / 2 + 1f,
              paint(1f, Typeface.NORMAL).apply { color = GREY })
        }
        if (urls.isNotEmpty()) {
          y = draw(canvas, urls, urlPaint, y)
          y += GAP / 4
        }
        y = draw(canvas, heads, headingPaint, y)
        if (bodies.isNotEmpty()) {
          y += GAP / 3
          y = draw(canvas, bodies, bodyPaint, y)
        }
        y += SECTION_GAP
      }

      val file = File(dir, if (name.endsWith(".png")) name else "$name.png")
      file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
      bitmap.recycle()

      LogFile.append("clip: wrote ${file.absolutePath} (${CANVAS_WIDTH}x$height, ${sections.size} sections)")
      promise.resolve(describe(file.absolutePath, CANVAS_WIDTH, maxOf(height, MIN_HEIGHT)))
    } catch (t: Throwable) {
      LogFile.append("clip: render failed $t")
      promise.reject("CLIP_FAILED", t.message ?: t.toString(), t)
    }
  }

  /**
   * Read the sections, cutting the whole clipping off once it is long enough.
   *
   * An unbounded clipping grows the canvas until the viewer, which scales to
   * fit, shrinks the type to nothing — so a very long one is worse than a
   * truncated one.
   */
  private fun parse(json: String): List<Section> {
    val array = JSONArray(json)
    val sections = mutableListOf<Section>()
    var budget = MAX_CHARS
    for (i in 0 until array.length()) {
      if (budget <= 0) {
        sections.add(Section("…", "", "The rest of this clipping was left out."))
        break
      }
      val entry = array.optJSONObject(i) ?: continue
      val heading = entry.optString("heading", "")
      val url = entry.optString("url", "")
      var body = entry.optString("body", "")
      if (body.length > budget) {
        body = body.substring(0, budget).trimEnd() + "…"
      }
      budget -= heading.length + body.length
      sections.add(Section(heading, url, body))
    }
    return sections
  }

  private fun paint(size: Float, style: Int) =
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.BLACK
        textSize = size
        typeface = Typeface.create(Typeface.SERIF, style)
      }

  private fun draw(canvas: Canvas, lines: List<String>, paint: Paint, top: Float): Float {
    var y = top - paint.ascent()
    for (line in lines) {
      canvas.drawText(line, MARGIN.toFloat(), y, paint)
      y += paint.fontSpacing
    }
    return y + paint.ascent()
  }

  /** Greedy word wrap that keeps the newlines already in the text. */
  private fun wrap(text: String, paint: Paint, maxWidth: Float): List<String> {
    if (text.isBlank()) {
      return emptyList()
    }
    val lines = mutableListOf<String>()
    for (paragraph in text.split("\n")) {
      val words = paragraph.split(" ").filter { it.isNotEmpty() }
      if (words.isEmpty()) {
        lines.add("")
        continue
      }
      var line = StringBuilder()
      for (word in words) {
        val candidate = if (line.isEmpty()) word else "$line $word"
        if (paint.measureText(candidate) <= maxWidth) {
          line = StringBuilder(candidate)
          continue
        }
        if (line.isNotEmpty()) {
          lines.add(line.toString())
          line = StringBuilder()
        }
        // A word too long for a whole line has to be broken mid-word — a URL
        // contains no spaces, so leaving it whole ran it straight off the edge
        // of the image with the rest of the address lost.
        var rest = word
        while (paint.measureText(rest) > maxWidth) {
          var cut = rest.length
          while (cut > 1 && paint.measureText(rest.substring(0, cut)) > maxWidth) {
            cut--
          }
          lines.add(rest.substring(0, cut))
          rest = rest.substring(cut)
        }
        line = StringBuilder(rest)
      }
      if (line.isNotEmpty()) {
        lines.add(line.toString())
      }
    }
    return lines
  }

  companion object {
    /** Beside the log, so everything this plugin leaves is in one place. */
    private const val CLIP_DIR = "Document/LookUp/clips"
    private const val CANVAS_WIDTH = 1400
    private const val MARGIN = 60
    private const val GAP = 24
    private const val SECTION_GAP = 34
    private const val RULE = 3f
    private const val MIN_HEIGHT = 400
    private const val TITLE_SIZE = 52f
    private const val SOURCE_SIZE = 30f
    private const val HEADING_SIZE = 42f
    private const val URL_SIZE = 34f
    private const val BODY_SIZE = 38f
    // Raising this to 12000 produced a bitmap 113,000 pixels tall, which is
    // most of a gigabyte in memory and beyond what the image viewer will open.
    private const val MAX_CHARS = 3000
    private val GREY = Color.rgb(90, 90, 90)
  }
}
