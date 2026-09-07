# Development notes

What was learned building this, kept because most of it cost a build cycle or a
page of handwriting to find out and none of it is written down anywhere else.

## Writing to a note page

**Flush before writing. Never save after.** This destroyed a page of handwriting
twice, in opposite ways, and the ordering is the whole of the fix.

Strokes the user has just drawn live only in the note app's memory. An element
write with `PluginFileAPI.insertElements` goes straight to the file, and the
`PluginCommAPI.reloadFile()` that must follow it replaces memory with disk — so
anything unflushed is gone. `PluginNoteAPI.saveCurrentNote()` immediately
*before* the write commits it. The same call *after* the write does the
opposite: it pushes the plugin's stale cached page back over what was just
written, taking the rest of the page with it.

The evidence, from a real failure: a page listed 21 elements (18 strokes, 3
text) and came back with 15 (11 strokes, 4 text). Disk had held 14; the 7
strokes lost were exactly the highest-numbered ones, drawn since the last save.
14 + 1 inserted icon = 15.

If the save is refused, write nothing. No feature is worth a page.

**Count the page either side of every write.** A census before and after turns a
silent corruption into a line in the log. It cannot prevent the damage, but
without it the cause is guesswork.

## Element facts

- `userData` is declared on `Element` in the SDK model and **discarded by the
  firmware**. Write 68 characters, read the element back, and it returns
  `uuid, type, layerNum, maxX, pageNum, thickness, maxY, recognizeResult,
  numInPage, textBox, status, contoursSrc, angles` — no `userData` at all.
  Set before the text box or after, read by `getElements` or `getElement`:
  gone. Nothing a plugin attaches to an element persists.
- What *does* survive: `textBox.textRect` exactly (written at 454,1177, read
  back at 454,1177) and `textBox.textContentFull`. Identification has to rest on
  those.
- `numInPage` has gaps **and is reused**. Always read it from the page at the
  moment of use; a remembered one deletes something else.
- Argument orders differ between neighbouring calls:
  `getElements(page, notePath)` but `getElement(notePath, page, num)`.
- A stroke reports **no bounding box** — `maxX`/`maxY` are canvas bounds,
  identical on every stroke. Its actual extent is in `points`, held in native
  cache behind `ElementDataAccessor`, far too costly to read per tap. So
  handwriting cannot be avoided when placing anything.
- A link carries its own geometry: `X, Y, width, height`, and `style: 0` is a
  solid underline that takes the touch. Anything placed inside a link's
  rectangle is swallowed by it.
- Element types: stroke 0, title 100, picture 200, text 500, digest quote 501,
  digest created 502, link 600, geometry 700, five star 800.
- Link types: 0 note page, 1 note file, 2 document, 3 image (the only one that
  pops up in place), 4 URL, 5 other, 6 digest.
- A text element with `textFrameStyle: 0` and `textEditable: 0` is an ordinary
  note text box, and the user can double-tap to edit it. Those fields do not
  mean read-only; a digest box uses `3` and `1`.

## Foreground gating

`PluginNoteAPI` is note-app-only: every write is refused with code 102, "This
app is not allowed to use this API", when a document is in front. `PluginFileAPI`
is gated on **the file being touched, not the API class** — from inside a book,
`getMarkPages` and `getElements` against the document's own files answer
normally while `createNote` against a note is refused.

A book's own markup is unreachable at all times: `<book>.mark` returns 1206
"File is locked" while the book is open, and 102 once it is closed. This is why
excerpts from a book go to the Digest instead.

## Touch

`PluginManager.registerMotionListener(1, {onMsg})` gives the touch stream on the
note outside the plugin view. `action` 0 is DOWN, 1 is UP; `toolType === 1 &&
pointerCount === 1` is a finger; movement between down and up is a drag, not a
tap. Motion coordinates and element rectangles share one coordinate space
(portrait), so a hit test is arithmetic.

Drop taps that arrive while one is still being handled. A tap reads the page,
writes an element, reloads and saves the store — none of it instant — and a
second tap arriving mid-flight reads stale state and undoes the first one's
decision. This is what made a pencil need three or four presses.

## How clippings work

Because `userData` does not persist, a clipping's text lives in the plugin's own
storage (`src/clippings.ts`, in the same SharedPreferences blob as the
settings), keyed by note path, page and the icon's rectangle. The icon on the
page is an ordinary text element showing the label.

`reconcile()` follows a pencil that has been moved: it pairs stored clippings
that are no longer where they were with pencils on the page that nothing claims,
nearest first, and updates the record. It works across the whole note, so a
pencil cut and pasted onto another page is found again. Anything still sitting
where it was recorded is matched exactly and never re-paired, so moving one
pencil cannot steal another's words.

Two honest gaps: swapping two pencils' positions in one move pairs them the
wrong way round, and a rubbed-out pencil leaves an orphan record.

The opened text is found by **what it says** first and its rectangle second,
because moving the pencil while it is open leaves the text behind — shutting by
rectangle alone deleted nothing and abandoned the text on the page.

Anything that writes the clippings must read-modify-write the whole blob:
`saveSettings` deliberately carries the `clippings` key across, or opening the
settings screen would delete every kept clipping.

## Supernote Cloud

Digests are "summaries". Base `https://viewer.supernote.com/api`:
`file/query/summary`, `file/add/summary`, `file/update/summary`,
`file/delete/summary`, `file/download/summary`. Paging uses `page`/`size`, not
`pageNo`/`pageSize`.

Sign-in: `official/user/query/random/code` → `official/user/account/login/new`
(password is SHA-256 of MD5(password) + randomCode; answers `errorCode E1760`
when an emailed code is needed) → `user/validcode/pre-auth` (the key is hidden
in the token: its last character indexes its own dash-separated parts) →
`user/mail/validcode/send` (sign is SHA-256 of email + key) →
`official/user/sms/login` (field is `email`, `equipment: '4'`, code upper-cased).

`E1760` arrives as `success: false`, so sign-in calls must not throw on that.

**Highlight offsets:** the device's position = our position − (number of
newlines before it). Guessed wrong twice; derived by calibrating against digests
the device had made itself, which is the only reliable way to learn an
undocumented format.

A source document is identified by size plus content MD5, not by path. Hashing
an 80MB PDF takes noticeable time — say so on screen or it reads as a dead
button.

## The web

No browser is possible. Android refuses to create a WebView in a privileged
process: `UnsupportedOperationException: For security reasons, WebView is not
allowed in privileged processes`, thrown from `WebViewFactory.getProvider`
during the constructor. It bypasses React error boundaries, the JS global
handler and a Java uncaught-exception handler alike — the window just opens and
disappears. Only an explicit `try/catch(Throwable)` around `WebView(context)`
reveals it.

Reachable without JavaScript: DuckDuckGo `html.duckduckgo.com/html/` and its
lite endpoint (needs a Lynx user agent), the Wikipedia API, Wiby. Blocked or
JS-only: Google, Mojeek, Textise.

Paging: DuckDuckGo's next page is a form it hands out with the current one,
carrying single-use tokens — `&s=10` just returns page 1. Wiby counts pages.
Both were assumed rather than tested at first, and both were wrong.

## Building

- **There is no Java on the development machine.** `buildPlugin.sh` fails the
  APK step and then *silently drops `nativeCodePackage` from the generated
  config* while still shipping `app.npk` in the package. The result installs and
  runs with the native module missing. Every build here re-adds
  `"nativeCodePackage": "/app.npk"` to `build/generated/PluginConfig.json` and
  repacks. Check for it before releasing.
- A `GITHUB_TOKEN` in the environment is a fine-grained PAT without write
  access and shadows the working `gho_` token. Push with
  `env -u GITHUB_TOKEN -u GH_TOKEN git push`.
- Diagnostics are a constant, `DIAGNOSTICS` in `src/log.ts`. Set it true and
  rebuild to get `Document/LookUp/log.txt` back. There is no console on the
  device, so this is the only way to see inside a fault.

## Known limitations

- A clipping does not travel with the `.note` to another device.
- Opened text can land on handwriting. Text boxes and links are avoided; ink
  cannot be.
- The pencil is an ordinary text box, so it can be typed into by accident.
- The toolbar inset is a fixed 120px on all four edges. Nothing in the SDK
  reports where the toolbar is docked or how wide it is.
- The digest feedback added in 2.21.1 has not been confirmed on the device.

## Restore points

`v2.13.0-known-good` and `v2.15.0-known-good` are tagged, both predating the
element-writing work.
