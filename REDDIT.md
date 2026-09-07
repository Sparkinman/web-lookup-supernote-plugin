**Title:** I built a Supernote plugin that lets you search the web from your handwriting and read the results on the page you're already on

---

I read a lot on my Supernote and kept hitting the same wall: something in a book or in my own notes needs looking up, and the only way to do it is to put the device down and pick up a phone. So I wrote a plugin.

**What it does**

Lasso some handwriting in a note, or select text in a book or PDF, and that selection becomes a web search. The results come back as plain text you read right there — no browser, no jumping out of what you were doing. You can follow a result, read the page itself as text, page through more results, or type an address by hand.

Handwriting gets recognised first, so you can lasso your own scrawl and it searches what you meant.

**Keeping what you find**

This is the part I use most. Choose the passages worth keeping and they come back to your note four ways, depending on what you want:

- **Keep as clipping** — a small pencil mark appears beside your handwriting. Tap it and the text opens on the page underneath. Tap it again and it folds away. No second page, no reopening the plugin. Move the writing and the mark follows it, even to a different page.
- **Paste selected text** — the passage written into the note as text, with a reference and links.
- **Insert link** — just a link to the page you read.
- **Screenshot** — a picture of what was on screen, linked from your note.

In a book it's different, because a plugin cannot write into a PDF or an EPUB — the firmware refuses every write while a document is in front. So a passage kept while reading goes into the device's own **Digest** instead, with a link back to the exact spot in the book. That needs your Supernote account, and it's the only part that does; the plugin talks to Supernote directly from the device, and everything else works without an account at all.

**Search engines**

DuckDuckGo, Wikipedia and Wiby, or an address you type. Each has a one-line description so you know what you're getting. You can also set up to ten one-tap refinements — mine are things like *explained*, *history*, *commentary* — which go in front of the query and toggle on and off.

**Privacy**

No account, no server of mine anywhere in it. Your search words go to the search engine you picked and to the pages you open, and nowhere else. Your password is never stored — only the session it earns, and only if you use the Digest feature. Settings live where only the plugin can read them.

**Honest limitations**

- A clipping's text lives on the device rather than inside the `.note` file, so it won't open on a different Supernote. Anything a plugin attaches to a page element is discarded by the firmware, so there is genuinely nowhere in the file to put it.
- Opened text can land on top of handwriting. The plugin can avoid text boxes and links because those report their rectangles; pen strokes don't report bounds at all.
- No pictures from web pages — text only. There is no way to render a web page inside a plugin; Android refuses to create a WebView in the process these run in.

**Get it**

Download the `.snplg` from the releases page and open it on the device: <LINK>

It's been through a lot of testing on my own daily notes, but it's a young plugin and it writes into your pages, so try it on a scratch note first. Bug reports welcome — especially anything about where things get placed on the page, which is the fiddliest part.
