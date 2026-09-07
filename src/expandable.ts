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
 * Read a mark with `getElement`, not `getElements`. The page listing comes back
 * with `userData` stripped -- an icon written with sixty-eight characters of it
 * read back as MISSING, and every tap on it reported `userData=NONE`. Fetching
 * that one element by its own number returns the mark intact. Collapse/Expand
 * carries a probe for the same gap. Note the argument orders differ:
 * `getElements(page, path)` against `getElement(path, page, num)`.
 *
 * Round A established the rest. A finger tap at 1089,930 was reported inside a
 * text box at 974,926..1174,978, so motion coordinates and element rectangles
 * share one space and a hit test is arithmetic. And a page of eleven strokes
 * numbered its text box `numInPage=14`, not 12 -- the numbering has gaps, so it
 * is always read and never inferred.
 */

import {PluginCommAPI, PluginFileAPI, PluginNoteAPI} from 'sn-plugin-lib';

import type {Anchor, Rect} from './capture';
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

/** How far outside an icon a tap still counts. Fingers are not precise. */
const HIT_PAD = 30;

/** Where opened text is drawn, and the room it may take. */
const GAP = 16;
const MARGIN = 60;
const TEXT_FONT = 34;

/**
 * A box that fits its label.
 *
 * A fixed square is right for one glyph and wrong for a word: "Paul" in a
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

/**
 * The `userData` of one element, read the only way that returns it.
 *
 * `getElements` drops the field, so an element from that listing is asked for
 * again by number. Falls back to whatever the listing held, in case a firmware
 * elsewhere does the reverse.
 */
async function markOf(
  path: string,
  page: number,
  element: Record<string, unknown>,
): Promise<string> {
  const listed = typeof element.userData === 'string' ? element.userData : '';
  if (listed) {
    return listed;
  }
  const num = Number(element.numInPage);
  if (!Number.isFinite(num)) {
    return '';
  }
  try {
    const fetched = unwrap<Record<string, unknown>>(await PluginFileAPI.getElement(path, page, num));
    return typeof fetched?.userData === 'string' ? fetched.userData : '';
  } catch (err) {
    log(`expandable: reading the mark of #${num} threw — ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
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
  const left = anchor.rect.left;
  const top = Math.min(anchor.rect.bottom + 20, (anchor.pageSize?.height ?? 2560) - ICON_SIZE - 20);
  const rect = boxFor(label, left, top);

  const element = unwrap<Record<string, unknown>>(await PluginCommAPI.createElement(TYPE_TEXT));
  if (!element) {
    return 'the element could not be made';
  }
  element.pageNum = page;
  element.layerNum = 0;
  element.userData = `${ICON_MARK}${JSON.stringify({id, text})}`;
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
    log(`expandable: inserted icon ${id} at ${left},${top} carrying ${text.length} characters`);
    log(`expandable: sent userData of ${String(element.userData).length} chars`);
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
  const kept = mine ? await markOf(path, page, mine) : '';
  log(
    `expandable: read back — ${mine ? `found at ${left},${top}` : 'NOT FOUND'}, ` +
      `userData ${kept ? `${kept.length} chars` : 'MISSING'}`,
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
export async function tapped(x: number, y: number): Promise<void> {
  // Said on every tap. A silent handler cannot be told apart from a listener
  // that never fired, which is exactly the ambiguity that wasted a round.
  log(`tap: ${Math.round(x)},${Math.round(y)}`);

  const path = unwrap<string>(await PluginCommAPI.getCurrentFilePath());
  const page = unwrap<number>(await PluginCommAPI.getCurrentPageNum());
  if (!path || typeof page !== 'number' || !/\.note$/i.test(path)) {
    log(`tap: not a note (${path ?? 'no path'})`);
    return;
  }

  const elements = unwrap<Record<string, unknown>[]>(await PluginFileAPI.getElements(page, path));
  if (!Array.isArray(elements)) {
    log('tap: the page could not be read');
    return;
  }

  // Only what the tap actually landed on is asked about. The mark comes from a
  // second read per candidate, because the page listing above returns none --
  // and candidates are nearly always none or one, so this costs nothing on the
  // overwhelming majority of taps, which hit no icon at all.
  const under = elements.filter(element => {
    const r = (element.textBox as {textRect?: Rect} | undefined)?.textRect;
    return (
      r != null &&
      x >= r.left - HIT_PAD &&
      x <= r.right + HIT_PAD &&
      y >= r.top - HIT_PAD &&
      y <= r.bottom + HIT_PAD
    );
  });

  let icon: Record<string, unknown> | undefined;
  let mark = '';
  for (const element of under) {
    const data = await markOf(path, page, element);
    const label = String(
      (element.textBox as {textContentFull?: string} | undefined)?.textContentFull ?? '',
    ).slice(0, 20);
    log(
      `tap: over #${String(element.numInPage)} "${label}" ` +
        `userData=${data ? `${data.length} chars starting "${data.slice(0, 24)}"` : 'NONE'}`,
    );
    if (!icon && data.startsWith(ICON_MARK)) {
      icon = element;
      mark = data;
    }
  }
  if (!icon) {
    log('tap: nothing of ours under it');
    return;
  }

  let carried: {id: string; text: string};
  try {
    carried = JSON.parse(mark.slice(ICON_MARK.length));
  } catch {
    log('expandable: an icon of ours carries something unreadable');
    return;
  }

  // Is this one already open? Only text elements can be the opened text, and a
  // page holds a handful of those, so each is asked for its mark.
  const openMark = `${OPEN_MARK}${carried.id}`;
  let open: Record<string, unknown> | undefined;
  for (const element of elements) {
    if (Number(element.type) !== TYPE_TEXT || element === icon) {
      continue;
    }
    if ((await markOf(path, page, element)) === openMark) {
      open = element;
      break;
    }
  }

  const before = await census(path, page, `tap on ${carried.id}: before`);

  // Same rule as placing one: commit the user's ink before touching the file.
  if (!(await flush())) {
    log('expandable: not writing — your latest strokes could not be saved first');
    return;
  }

  if (open) {
    // The number is taken from this read rather than remembered: numbering has
    // gaps and a stale one would delete something else.
    const num = Number(open.numInPage);
    log(`expandable: shutting ${carried.id}, deleting element ${num}`);
    try {
      const response = (await PluginFileAPI.deleteElements(path, page, [num])) as
        | LooseResponse<boolean>
        | null
        | undefined;
      if (!response?.success) {
        log(`expandable: delete refused — ${response?.error?.message ?? 'no reason given'}`);
      }
    } catch (err) {
      log(`expandable: delete threw — ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    await draw(path, page, icon, carried);
  }

  try {
    await PluginCommAPI.reloadFile();
  } catch (err) {
    log(`expandable: reloadFile threw — ${err instanceof Error ? err.message : String(err)}`);
  }
  const after = await census(path, page, `tap on ${carried.id}: after`);
  if (before > 0 && after >= 0 && Math.abs(after - before) > 1) {
    log(`expandable: WARNING the page went from ${before} to ${after} on one tap`);
  }
}

/** Write the carried words onto the page, just below their icon. */
async function draw(
  path: string,
  page: number,
  icon: Record<string, unknown>,
  carried: {id: string; text: string},
): Promise<void> {
  const box = icon.textBox as {textRect?: Rect} | undefined;
  const rect = box?.textRect;
  if (!rect) {
    return;
  }
  const size = unwrap<{width: number; height: number}>(await PluginFileAPI.getPageSize(path, page));
  const width = size?.width ?? 1920;
  const height = size?.height ?? 2560;

  const left = Math.min(rect.left, width - MARGIN - 400);
  const right = width - MARGIN;
  const top = rect.bottom + GAP;
  // No text metrics are reported, so the height is estimated from an average
  // character width. Too tall costs nothing, where too short clips the tail.
  const perLine = Math.max(10, Math.floor((right - left) / (TEXT_FONT * 0.5)));
  const lines = carried.text
    .split('\n')
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / perLine)), 0);
  const bottom = Math.min(height - MARGIN, top + Math.round(lines * TEXT_FONT * 1.5) + TEXT_FONT);
  if (bottom - top < TEXT_FONT) {
    log('expandable: no room below the icon to open it');
    return;
  }

  const element = unwrap<Record<string, unknown>>(await PluginCommAPI.createElement(TYPE_TEXT));
  if (!element) {
    return;
  }
  element.pageNum = page;
  element.layerNum = 0;
  element.userData = `${OPEN_MARK}${carried.id}`;
  element.textBox = {
    fontSize: TEXT_FONT,
    textContentFull: carried.text,
    textRect: {left, top, right, bottom},
    textAlign: 0,
    textBold: 0,
    textItalics: 0,
    textFrameWidthType: 0,
    textFrameStyle: 0,
    textEditable: 0,
  };

  try {
    const response = (await PluginFileAPI.insertElements(path, page, [element])) as
      | LooseResponse<boolean>
      | null
      | undefined;
    log(
      response?.success
        ? `expandable: opened ${carried.id}`
        : `expandable: opening refused — ${response?.error?.message ?? 'no reason given'}`,
    );
  } catch (err) {
    log(`expandable: opening threw — ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try {
      (element as {recycle?: () => Promise<void>}).recycle?.();
    } catch {
      // Nothing useful to do about it.
    }
  }
}
