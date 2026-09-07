/**
 * Tap an icon to open the clipping it carries, tap it again to shut it.
 *
 * Two rules govern every write here, both learned by destroying a page.
 *
 * Save BEFORE writing, never after. Strokes the user has just drawn live only
 * in the note app's memory until something flushes them. An element write goes
 * straight to the file, and the `reloadFile` that must follow it replaces the
 * in-memory page with what is on disk -- so anything unflushed is gone. That is
 * what took seven strokes off a twenty-one element page. `saveCurrentNote`
 * first commits them; `saveCurrentNote` afterwards would do the opposite and
 * push the plugin's stale cached copy back over the write, which is what took
 * the page before that. Collapse/Expand says both, and does exactly this.
 *
 * Nothing may be attached to an element. `userData` is declared in the SDK
 * model and discarded by the firmware: an icon written with sixty-eight
 * characters of it reads back carrying `uuid, type, layerNum, maxX, pageNum,
 * thickness, maxY, recognizeResult, numInPage, textBox, status, contoursSrc,
 * angles` and no `userData` at all -- set before the text box or after it,
 * read by `getElements` or by `getElement`. So a clipping's words live in the
 * plugin's own store and the icon is found by where it sits; a rectangle
 * written at 454,1177 reads back at 454,1177. See `clippings.ts`.
 *
 * Round A established the rest. A finger tap at 1089,930 was reported inside a
 * text box at 974,926..1174,978, so motion coordinates and element rectangles
 * share one space and a hit test is arithmetic. And a page of eleven strokes
 * numbered its text box `numInPage=14`, not 12 -- the numbering has gaps, so it
 * is always read and never inferred.
 */

import {PluginCommAPI, PluginFileAPI, PluginNoteAPI} from 'sn-plugin-lib';

import type {Anchor, Rect} from './capture';
import type {Clipping} from './clippings';
import {addClipping, clippingAt, clippingsInNote, updateClipping} from './clippings';
import {log} from './log';

interface LooseResponse<T> {
  success?: boolean;
  result?: T | null;
  error?: {message?: string} | null;
}

const TYPE_TEXT = 500;

/** What marks an element as ours. */
export const ICON_MARK = 'weblookup-icon:';

const ICON_SIZE = 72;
const ICON_FONT = 44;

/** What marks the text an icon has opened, so it can be found and shut. */
export const OPEN_MARK = 'weblookup-open:';

/**
 * Whether a tap is already being dealt with.
 *
 * One tap does several things that are not instant: it reads the page, writes
 * an element, reloads the file and saves the store. A second tap arriving in
 * the middle read the store before the first had finished writing it, decided
 * the clipping was still shut, and opened a second copy -- or opened and shut
 * in the wrong order, so that several taps appeared to do nothing at all.
 * Taps that arrive mid-flight are dropped: the finger is faster than the file.
 */
let working = false;

/** Where opened text is drawn, and the room it may take. */
const GAP = 16;
const TEXT_FONT = 34;

/**
 * How far in from every edge anything may be written.
 *
 * The toolbar can be docked on any of the four sides and nothing in the SDK
 * reports where it is or how wide it is -- `PluginManager` mentions toolbars
 * only to register buttons on them. So the same inset is kept on all four
 * edges, wide enough for the bar wherever it has been put. Erring wide costs a
 * little room; erring narrow puts the pencil somewhere no tap can reach it.
 */
const MARGIN = 120;

/**
 * A box that fits its label.
 *
 * A fixed square is right for one glyph and wrong for a word: a name in a
 * seventy-pixel box at forty-four point has nowhere to go but downwards, one
 * letter per line. The device reports no text metrics, so the width is
 * estimated generously -- too wide costs nothing, too narrow stacks it.
 */
function boxFor(label: string, left: number, top: number): Rect {
  const width = Math.max(ICON_SIZE, Math.round(ICON_FONT * label.length * 0.72) + ICON_FONT);
  return {left, top, right: left + width, bottom: top + ICON_SIZE};
}

function unwrap<T>(res: unknown): T | null {
  const parsed = res as LooseResponse<T> | null | undefined;
  return parsed?.success && parsed.result != null ? parsed.result : null;
}

/**
 * Commit whatever the user has drawn but not yet saved.
 *
 * Must run before every element write. Without it the `reloadFile` that follows
 * the write discards every stroke made since the last flush -- the page loses
 * work the user watched themselves do, which is the worst failure this plugin
 * has. Returns false if the note app refused, and the caller then writes
 * nothing: no icon is worth a page.
 */
async function flush(): Promise<boolean> {
  try {
    const response = (await PluginNoteAPI.saveCurrentNote()) as LooseResponse<boolean> | null;
    if (!response?.success) {
      log(`expandable: save refused — ${response?.error?.message ?? 'no reason given'}`);
      return false;
    }
    return true;
  } catch (err) {
    log(`expandable: save threw — ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Every rectangle already spoken for on this page. */
function occupied(elements: Record<string, unknown>[]): Rect[] {
  const taken: Rect[] = [];
  for (const element of elements) {
    const box = (element.textBox as {textRect?: Rect} | undefined)?.textRect;
    if (box) {
      taken.push(box);
    }
    // A link is not a text box: it carries its own position and size, and its
    // default style is a solid underline drawn across whatever sits there. An
    // icon placed inside one is swallowed by it -- the link takes the touch,
    // so the pencil gets underlined and opens the link instead of the words.
    const link = element.link as
      | {X?: number; Y?: number; width?: number; height?: number}
      | undefined;
    if (link && typeof link.X === 'number' && typeof link.Y === 'number') {
      taken.push({
        left: link.X,
        top: link.Y,
        right: link.X + (link.width ?? 0),
        bottom: link.Y + (link.height ?? 0),
      });
    }
  }
  return taken;
}

function overlaps(a: Rect, b: Rect): boolean {
  return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
}

/**
 * Somewhere the pencil can sit without being sat on.
 *
 * Beside the writing first, which is where a margin mark belongs and, more to
 * the point, is out of the row of link labels that "Insert link and notes"
 * puts directly beneath it. Failing that, down the left in steps until there
 * is a gap. Returns null when the page has no room, and the caller writes
 * nothing rather than putting the pencil somewhere it cannot be tapped.
 */
function freeSpot(
  writing: Rect,
  width: number,
  height: number,
  taken: Rect[],
  pageWidth: number,
  pageHeight: number,
): Rect | null {
  const candidates: Rect[] = [];
  const beside = writing.right + GAP;
  if (beside + width <= pageWidth - MARGIN) {
    const top = Math.max(
      MARGIN,
      Math.min(writing.bottom - height, pageHeight - height - MARGIN),
    );
    candidates.push({left: beside, top, right: beside + width, bottom: top + height});
  }
  const left = Math.max(MARGIN, Math.min(writing.left, pageWidth - width - MARGIN));
  for (
    let top = Math.max(MARGIN, writing.bottom + GAP);
    top + height <= pageHeight - MARGIN;
    top += height + GAP
  ) {
    candidates.push({left, top, right: left + width, bottom: top + height});
  }
  for (const spot of candidates) {
    if (!taken.some(other => overlaps(spot, other))) {
      return spot;
    }
  }
  return null;
}

/** Read the page and say what is on it, for comparing before with after. */
async function census(path: string, page: number, when: string): Promise<number> {
  const elements = unwrap<Record<string, unknown>[]>(await PluginFileAPI.getElements(page, path));
  if (!Array.isArray(elements)) {
    log(`expandable: ${when} — the page could not be read`);
    return -1;
  }
  const kinds: Record<string, number> = {};
  for (const element of elements) {
    const key = String(element.type);
    kinds[key] = (kinds[key] ?? 0) + 1;
  }
  log(
    `expandable: ${when} — ${elements.length} element(s), by type ` +
      Object.entries(kinds)
        .map(([type, count]) => `${type}x${count}`)
        .join(' '),
  );
  return elements.length;
}

/**
 * Place one icon carrying the given words, and check the page afterwards.
 *
 * Returns null when it worked, or a reason. The words ride in the element's own
 * `userData`, so the clipping travels with the page it belongs to.
 */
export async function placeIcon(
  anchor: Anchor,
  label: string,
  text: string,
): Promise<string | null> {
  if (!anchor.rect) {
    return 'there is no selection to hang it from';
  }
  const path = anchor.source.path;
  const page = anchor.source.page;

  const before = await census(path, page, 'before');
  if (before < 0) {
    return 'the page could not be read, so nothing was written';
  }

  // Before anything is written, and before the reload that must follow it.
  if (!(await flush())) {
    return 'your latest strokes could not be saved, so nothing was written';
  }

  const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const pageWidth = anchor.pageSize?.width ?? 1920;
  const pageHeight = anchor.pageSize?.height ?? 2560;
  const size = boxFor(label, 0, 0);

  // Beside the writing, or below it, but never on top of anything already
  // there. "Insert links" lays its labels in a row immediately beneath the
  // handwriting, at the very spot the pencil used to take -- and a link is
  // drawn as an underline that swallows the touch, so the pencil came out
  // underlined and opened the link instead of the words.
  const existing = unwrap<Record<string, unknown>[]>(await PluginFileAPI.getElements(page, path));
  const rect = freeSpot(
    anchor.rect,
    size.right - size.left,
    size.bottom - size.top,
    Array.isArray(existing) ? occupied(existing) : [],
    pageWidth,
    pageHeight,
  );
  if (!rect) {
    return 'there is no clear space on this page to put the mark';
  }
  const left = rect.left;
  const top = rect.top;

  const element = unwrap<Record<string, unknown>>(await PluginCommAPI.createElement(TYPE_TEXT));
  if (!element) {
    return 'the element could not be made';
  }
  // Order matters. These are native-backed objects, and assigning the whole
  // `textBox` struct appears to rebuild the element underneath -- a `userData`
  // set before it did not survive the insert, while Collapse/Expand, which sets
  // the box first and the mark second, keeps its own. So: box, then mark.
  element.textBox = {
    fontSize: ICON_FONT,
    textContentFull: label,
    textRect: rect,
    textAlign: 0,
    textBold: 0,
    textItalics: 0,
    textFrameWidthType: 0,
    textFrameStyle: 0,
    textEditable: 0,
  };
  // Still set, in case a future firmware keeps it, but nothing depends on it.
  element.userData = `${ICON_MARK}${JSON.stringify({id})}`;
  element.pageNum = page;

  let inserted = false;
  try {
    const response = (await PluginFileAPI.insertElements(path, page, [element])) as
      | LooseResponse<boolean>
      | null
      | undefined;
    inserted = Boolean(response?.success);
    if (!inserted) {
      const why = response?.error?.message ?? 'the device refused it';
      log(`expandable: insert refused — ${why}`);
      return why;
    }
    log(
      `expandable: inserted icon ${id} at ${left},${top}..${rect.right},${rect.bottom} ` +
        `carrying ${text.length} characters`,
    );
  } catch (err) {
    const why = err instanceof Error ? err.message : 'an unknown error';
    log(`expandable: insert threw — ${why}`);
    return why;
  } finally {
    // Elements carry native cached data and are released by hand, as
    // Collapse/Expand does after each of its own batches.
    try {
      (element as {recycle?: () => Promise<void>}).recycle?.();
    } catch {
      // Nothing useful to do about it.
    }
  }

  // The words go to our own store, keyed by where the icon sits. The element
  // cannot carry them: `userData` is discarded by the firmware.
  await addClipping({id, path, page, rect, label, text});

  // The save happened before the write, never here: saving now would push the
  // plugin's stale cached page back over the element just inserted.
  try {
    const reloaded = (await PluginCommAPI.reloadFile()) as LooseResponse<boolean> | null;
    log(`expandable: reloadFile ${reloaded?.success ? 'ok' : JSON.stringify(reloaded ?? null)}`);
  } catch (err) {
    log(`expandable: reloadFile threw — ${err instanceof Error ? err.message : String(err)}`);
  }

  // Read our own icon back. If the mark is gone here, it was lost in the write
  // rather than in the reading, and no amount of hit-testing will find it.
  const written = unwrap<Record<string, unknown>[]>(await PluginFileAPI.getElements(page, path));
  const mine = Array.isArray(written)
    ? written.find(e => {
        const b = e.textBox as {textRect?: Rect} | undefined;
        return b?.textRect?.left === left && b?.textRect?.top === top;
      })
    : undefined;
  log(
    `expandable: read back — ${mine ? `found at ${left},${top}, which is how it will be found again` : 'NOT FOUND'}`,
  );

  const after = await census(path, page, 'after');
  if (after >= 0 && after < before + 1) {
    log(`expandable: WARNING the page went from ${before} to ${after} elements`);
    return `the page lost content (${before} elements before, ${after} after) — tell me before doing anything else`;
  }
  log(`expandable: page went from ${before} to ${after} elements, as expected`);
  return null;
}

/**
 * A finger tap landed. Open or shut whichever clipping is under it.
 *
 * Round C. Quiet about everything that is not ours: a tap that hits no icon is
 * the overwhelming majority of taps and must cost one page read and say
 * nothing. Still no saveCurrentNote anywhere, and the page is counted either
 * side of every write so the log says whether anything went missing.
 */
/** Two rectangles in the same place, allowing for rounding. */
function samePlace(a: Rect, b: Rect): boolean {
  return Math.abs(a.left - b.left) <= 2 && Math.abs(a.top - b.top) <= 2;
}

function centre(r: Rect): {x: number; y: number} {
  return {x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2};
}

/**
 * Follow the pencils that have been moved.
 *
 * A clipping is found by where its icon sits, so dragging the handwriting and
 * the icon somewhere else leaves the stored rectangle pointing at bare paper
 * and the pencil stops answering. This reads the page, pairs each stored
 * clipping that is no longer where it was with a pencil on the page that
 * nothing claims, and moves the record to match. The opened text, if any, is
 * shifted by the same amount, since it travels with the icon.
 *
 * Nearest first, so the pairing is stable when several have moved at once.
 * A clipping whose pencil has been rubbed out finds no partner and is left
 * alone rather than being attached to somebody else's.
 */
async function reconcile(path: string, page: number): Promise<void> {
  // Every clipping in this note, not only the ones recorded on this page.
  // Handwriting and its pencil can be cut and pasted onto another page, and a
  // clipping that only ever looked at the page it was made on went silent the
  // moment that happened.
  const mine = await clippingsInNote(path);
  if (mine.length === 0) {
    return;
  }
  const elements = unwrap<Record<string, unknown>[]>(await PluginFileAPI.getElements(page, path));
  if (!Array.isArray(elements)) {
    return;
  }

  // Only boxes reading exactly what one of our icons reads. The opened text is
  // a text element too, and is not a candidate.
  const labels = new Set(mine.map(c => c.label));
  const pencils: Rect[] = [];
  for (const element of elements) {
    if (Number(element.type) !== TYPE_TEXT) {
      continue;
    }
    const box = element.textBox as {textRect?: Rect; textContentFull?: string} | undefined;
    if (box?.textRect && labels.has(String(box.textContentFull ?? ''))) {
      pencils.push(box.textRect);
    }
  }

  // A clipping already sitting where it says it is on this page is settled.
  // One recorded on another page is a candidate: it may have been moved here.
  const strayClippings = mine.filter(
    c => !(c.page === page && pencils.some(p => samePlace(p, c.rect))),
  );
  const strayPencils = pencils.filter(
    p => !mine.some(c => c.page === page && samePlace(p, c.rect)),
  );
  if (strayClippings.length === 0 || strayPencils.length === 0) {
    return;
  }

  const spare = [...strayPencils];
  for (const clipping of strayClippings) {
    if (spare.length === 0) {
      break;
    }
    const from = centre(clipping.rect);
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < spare.length; i += 1) {
      const to = centre(spare[i]);
      const distance = (to.x - from.x) ** 2 + (to.y - from.y) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    const moved = spare.splice(best, 1)[0];
    const dx = moved.left - clipping.rect.left;
    const dy = moved.top - clipping.rect.top;
    const patch: Partial<Clipping> = {rect: moved, page};
    if (clipping.openRect) {
      patch.openRect = {
        left: clipping.openRect.left + dx,
        top: clipping.openRect.top + dy,
        right: clipping.openRect.right + dx,
        bottom: clipping.openRect.bottom + dy,
      };
    }
    // The opened text does not follow a move between pages, so a clipping
    // that lands on a new page is treated as shut: its old text, if any, is
    // still on the page it came from and is the user's to remove.
    if (clipping.page !== page) {
      patch.openRect = undefined;
      patch.openText = undefined;
    }
    await updateClipping(clipping.id, patch);
  }
}

export async function tapped(x: number, y: number): Promise<void> {
  // Said on every tap. A silent handler cannot be told apart from a listener
  // that never fired, which is exactly the ambiguity that wasted a round.
  log(`tap: ${Math.round(x)},${Math.round(y)}`);

  if (working) {
    return;
  }
  working = true;
  try {
    await handleTap(x, y);
  } finally {
    working = false;
  }
}

async function handleTap(x: number, y: number): Promise<void> {
  const path = unwrap<string>(await PluginCommAPI.getCurrentFilePath());
  const page = unwrap<number>(await PluginCommAPI.getCurrentPageNum());
  if (!path || typeof page !== 'number' || !/\.note$/i.test(path)) {
    return;
  }

  // Identification happens entirely in our own store: no page read, nothing
  // asked of the element, and so nothing that depends on a field the firmware
  // throws away. A tap that hits no clipping costs one small file read.
  // The cheap path first: a pencil that has not moved needs no page read at
  // all. Only a miss pays for one, and only then to see whether something was
  // dragged since it was last seen.
  let clipping = await clippingAt(path, page, x, y);
  if (!clipping) {
    await reconcile(path, page);
    clipping = await clippingAt(path, page, x, y);
  }
  if (!clipping) {
    log('tap: nothing of ours under it');
    return;
  }
  log(`tap: on ${clipping.id}, currently ${clipping.openRect ? 'open' : 'shut'}`);

  const before = await census(path, page, `tap on ${clipping.id}: before`);

  // Same rule as placing one: commit the user's ink before touching the file.
  if (!(await flush())) {
    log('expandable: not writing — your latest strokes could not be saved first');
    return;
  }

  if (clipping.openRect) {
    await shut(path, page, clipping.id, clipping.openRect, clipping.openText);
  } else {
    await draw(path, page, clipping.id, clipping.rect, clipping.text);
  }

  try {
    await PluginCommAPI.reloadFile();
  } catch (err) {
    log(`expandable: reloadFile threw — ${err instanceof Error ? err.message : String(err)}`);
  }
  const after = await census(path, page, `tap on ${clipping.id}: after`);
  if (before > 0 && after >= 0 && Math.abs(after - before) > 1) {
    log(`expandable: WARNING the page went from ${before} to ${after} on one tap`);
  }
}

/**
 * Take the opened text back off the page.
 *
 * The element is found by the rectangle it was written at, for the same reason
 * the icon is: it is the one thing about our elements that survives. The number
 * is read from the page at this moment rather than remembered, because
 * numbering has gaps and is reused -- a remembered one would delete a stroke.
 */
async function shut(
  path: string,
  page: number,
  id: string,
  openRect: Rect,
  openText: string | undefined,
): Promise<void> {
  const elements = unwrap<Record<string, unknown>[]>(await PluginFileAPI.getElements(page, path));
  const texts = Array.isArray(elements)
    ? elements.filter(element => Number(element.type) === TYPE_TEXT)
    : [];

  const boxOf = (element: Record<string, unknown>) =>
    element.textBox as {textRect?: Rect; textContentFull?: string} | undefined;

  // What it says first, where it was second. Moving the pencil while it is
  // open leaves the text behind, so the recorded rectangle points at bare
  // paper -- shutting by rectangle alone deleted nothing and left the text
  // stranded on the page with no pencil that would ever take it away again.
  let open: Record<string, unknown> | undefined;
  if (openText) {
    const saying = texts.filter(element => boxOf(element)?.textContentFull === openText);
    if (saying.length === 1) {
      open = saying[0];
    } else if (saying.length > 1) {
      // Two clippings of the same passage. The nearer to where this one was
      // last seen is this one.
      let best = Infinity;
      for (const element of saying) {
        const r = boxOf(element)?.textRect;
        if (!r) {
          continue;
        }
        const distance = (r.left - openRect.left) ** 2 + (r.top - openRect.top) ** 2;
        if (distance < best) {
          best = distance;
          open = element;
        }
      }
    }
  }
  if (!open) {
    open = texts.find(element => {
      const r = boxOf(element)?.textRect;
      return r != null && samePlace(r, openRect);
    });
  }

  if (!open) {
    // The user deleted it by hand. Shut is still the right outcome.
    log(`expandable: nothing open to shut for ${id} — marking it shut`);
    await updateClipping(id, {openRect: undefined, openText: undefined});
    return;
  }

  const num = Number(open.numInPage);
  log(`expandable: shutting ${id}, deleting element ${num}`);
  try {
    const response = (await PluginFileAPI.deleteElements(path, page, [num])) as
      | LooseResponse<boolean>
      | null
      | undefined;
    if (!response?.success) {
      log(`expandable: delete refused — ${response?.error?.message ?? 'no reason given'}`);
      return;
    }
  } catch (err) {
    log(`expandable: delete threw — ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  await updateClipping(id, {openRect: undefined, openText: undefined});
}
/**
 * Write the kept words onto the page, just below their icon.
 *
 * Where it lands is recorded, because that rectangle is how the text is found
 * again when the icon is tapped a second time to shut it.
 */
async function draw(
  path: string,
  page: number,
  id: string,
  iconRect: Rect,
  text: string,
): Promise<void> {
  const size = unwrap<{width: number; height: number}>(await PluginFileAPI.getPageSize(path, page));
  const width = size?.width ?? 1920;
  const height = size?.height ?? 2560;

  // Margin to margin, not from the icon rightwards. Starting at the icon gave
  // a pencil near the right edge a four-hundred-pixel column, and a thousand
  // characters needed two and a half pages of it -- the box was clamped at the
  // page edge and the tail was simply cut off. The full width holds the same
  // thousand characters in about ten lines.
  const left = MARGIN;
  const right = width - MARGIN;

  // No text metrics are reported, so the height is estimated from an average
  // character width. Too tall costs nothing, where too short clips the tail.
  const perLine = Math.max(10, Math.floor((right - left) / (TEXT_FONT * 0.5)));
  const linesFor = (body: string) =>
    body
      .split('\n')
      .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / perLine)), 0);
  const heightFor = (body: string) => Math.round(linesFor(body) * TEXT_FONT * 1.5) + TEXT_FONT;

  // Below the icon by preference, but lifted up the page when what is being
  // opened will not fit there. Never past the top margin.
  const needed = heightFor(text);
  const room = height - MARGIN;
  let top = iconRect.bottom + GAP;
  if (top + needed > room) {
    top = Math.max(MARGIN, room - needed);
  }

  // Prefer a band with nothing in it. Only what the device will describe can
  // be avoided -- text boxes and links carry rectangles, handwriting does not:
  // a stroke reports no bounds at all, only its sample points, held in native
  // cache and far too costly to read on every tap. So this steers clear of
  // boxes and links, and ink is a genuine trade-off rather than an oversight.
  const onPage = unwrap<Record<string, unknown>[]>(await PluginFileAPI.getElements(page, path));
  const taken = Array.isArray(onPage) ? occupied(onPage) : [];
  if (taken.length > 0) {
    const tries: number[] = [];
    for (let t = top; t + needed <= room; t += TEXT_FONT) {
      tries.push(t);
    }
    for (let t = MARGIN; t + needed <= room; t += TEXT_FONT) {
      tries.push(t);
    }
    const clear = tries.find(
      t => !taken.some(other => overlaps({left, top: t, right, bottom: t + needed}, other)),
    );
    if (clear != null) {
      top = clear;
    } else {
      log('expandable: opening over something — no clear band wide enough on this page');
    }
  }
  const available = room - top;
  if (available < TEXT_FONT * 2) {
    log('expandable: no room on this page to open it');
    return;
  }

  // A clipping longer than a whole page cannot be shown whole. Better to show
  // what fits and say so than to write a box the page silently truncates: the
  // words themselves are safe in the store either way.
  let shown = text;
  if (needed > available) {
    const fits = Math.max(1, Math.floor((available - TEXT_FONT) / (TEXT_FONT * 1.5)));
    shown = `${text.slice(0, Math.max(1, fits * perLine - 2)).trimEnd()}…`;
    log(`expandable: only ${shown.length} of ${text.length} characters fit on this page`);
  }

  const bottom = Math.min(room, top + heightFor(shown));
  const openRect: Rect = {left, top, right, bottom};

  const element = unwrap<Record<string, unknown>>(await PluginCommAPI.createElement(TYPE_TEXT));
  if (!element) {
    return;
  }
  element.textBox = {
    fontSize: TEXT_FONT,
    textContentFull: shown,
    textRect: openRect,
    textAlign: 0,
    textBold: 0,
    textItalics: 0,
    textFrameWidthType: 0,
    textFrameStyle: 0,
    textEditable: 0,
  };
  element.userData = `${OPEN_MARK}${id}`;
  element.pageNum = page;

  try {
    const response = (await PluginFileAPI.insertElements(path, page, [element])) as
      | LooseResponse<boolean>
      | null
      | undefined;
    if (!response?.success) {
      log(`expandable: opening refused — ${response?.error?.message ?? 'no reason given'}`);
      return;
    }
    log(`expandable: opened ${id} at ${left},${top}..${right},${bottom}`);
  } catch (err) {
    log(`expandable: opening threw — ${err instanceof Error ? err.message : String(err)}`);
    return;
  } finally {
    try {
      (element as {recycle?: () => Promise<void>}).recycle?.();
    } catch {
      // Nothing useful to do about it.
    }
  }

  // Recorded only after the write succeeded, so a failed open leaves the
  // clipping shut rather than pointing at text that is not there.
  await updateClipping(id, {openRect, openText: shown});
}
