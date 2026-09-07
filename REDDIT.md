**Title:** I built a working text-only web browser inside a Supernote plugin

---

I kept hitting the same wall reading on my Supernote: something in a book or in my own notes needs looking up, and the only way is to put the device down and pick up a phone. So I wrote a plugin. Lasso your handwriting, or select text in a book, and it becomes a web search — results come back as plain text you read on the page you were already on.

**It's a real browser, just without pictures.** Search DuckDuckGo, Wikipedia or Wiby, follow any result, read the page itself, page through more, or type an address by hand. Handwriting is recognised first, so lassoing your own scrawl searches what you meant.

**Keeping what you find.** This is the part I use most, and there are four ways, all landing back in the note you started from:

- **A clipping** — a small pencil mark appears beside your handwriting. Tap it and the text unfolds on the page underneath; tap again and it folds away. No second page, no reopening the plugin. Move the writing and the mark follows it, even to another page.
- **The text itself**, written into the note with a reference.
- **A link** to the page you read. Tap it and it opens in the Supernote's own built-in browser — the plugin can't render a page, but the firmware can, so the link hands off to it.
- **A screenshot** of what was on screen, saved and linked from your note.

In a book it works differently, because a plugin cannot write into a PDF or an EPUB. Instead the passage goes into **Supernote's own built-in Digest** — not a lookalike the plugin builds, the real one — with the excerpt pinned into the Digest's typed area and a link back to the exact spot in the book. That last part took a while: the device stores highlight offsets counted without newlines, so getting the link to land on the right sentence meant calibrating against digests the device had made itself.

**The limits I hit, in case they save someone else the time:**

*You cannot show a web page.* Not with a WebView, not with a hand-written native view. PluginHost runs as a privileged system process and Android flatly refuses to create a WebView in one. Worse, the exception is thrown while the native view is being constructed, so it slips past React error boundaries and the JS error handler alike — the plugin window just opens and vanishes with nothing written anywhere. Everything is fetched over the network and rendered with ordinary React Native components instead.

*Most search engines are unreachable.* Google, Mojeek and Textise are all blocked or need JavaScript. DuckDuckGo's HTML endpoint works if you send a Lynx user agent. Wikipedia's API and Wiby work plainly.

*A plugin cannot write into a book.* Every write is refused outright while a PDF or EPUB is in front, and the book's own markup file is locked while it is open and forbidden once it is closed — unreachable at all times. Hence the Digest route above.

**The nested-notes feature was the hard part.** I wanted a clipping you could fold into a small mark beside your handwriting and tap to open in place, instead of jumping to another page. Two things went wrong:

It destroyed a page of handwriting — twice. Strokes you have just drawn live only in the note app's memory. An element write goes straight to the file, and the reload that must follow it replaces memory with disk, so anything unflushed dies. Seven strokes off a twenty-one element page, and the arithmetic matched exactly: the survivors were precisely the ones already saved. The fix is one call in the right place — flush *before* writing, never after, because saving afterwards pushes the plugin's stale cached page back over what you just wrote. Both orderings destroy a page; only one order is correct.

And you cannot attach anything to an element. `userData` is a documented string field on every note element. Write sixty-eight characters to it, read the element back, and it returns `uuid, type, layerNum, maxX, pageNum, thickness, maxY, recognizeResult, numInPage, textBox, status, contoursSrc, angles` — no `userData` at all. Before the text box or after, read singly or in a page listing: gone. So the clipping's text lives in the plugin's own storage and the mark is found by where it sits on the page, which means clippings don't travel with the `.note` to another device. There is genuinely nowhere in the file to put them.

**No account, no server.** Your search words go to the engine you picked and nowhere else. The Supernote sign-in is optional and only for the Digest; it talks to Supernote directly from the device and stores the session, never your password.

Download and details: https://github.com/Sparkinman/web-lookup-supernote-plugin/releases/latest

It writes into your pages, so try it on a scratch note first. Bug reports welcome.
