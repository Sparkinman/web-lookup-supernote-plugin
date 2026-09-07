/**
 * Round B: put one icon on a page and prove the page survives it.
 *
 * The previous attempt destroyed a page, and the cause is known: calling
 * `saveCurrentNote` after an element write pushes the plugin's stale cached
 * copy of the page back over the real file, taking everything on it.
 * Collapse/Expand says so twice in its own source, beside its writes and beside
 * its deletion. Nothing here saves. `reloadFile` refreshes the cache instead,
 * which is what that plugin does.
 *
 * Round A established the two things this rests on. A finger tap at 1089,930
 * was reported inside a text box at 974,926..1174,978, so motion coordinates
 * and element rectangles share one space and a hit test is arithmetic. And a
 * page of eleven strokes numbered its text box `numInPage=14`, not 12 -- the
 * numbering has gaps, so it is always read and never inferred.
 *
 * This round writes one element and then reads the page back, so the log says
 * plainly whether everything that was there before is still there.
 */

import {PluginCommAPI, PluginFileAPI} from 'sn-plugin-lib';

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

  // Not saveCurrentNote. Reads come from a cache that lags an element write,
  // and saving inside that window writes the stale cache over the real file --
  // which is exactly what destroyed a page.
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
  const kept = typeof mine?.userData === 'string' ? mine.userData : '';
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

  // What the tap is over, and what each of those carries. The icon placed last
  // time came back with no userData at all, so the mark that identifies it as
  // ours was lost somewhere between being set and being read -- and this says
  // which of those it is.
  for (const element of elements) {
    const box = element.textBox as {textRect?: Rect; textContentFull?: string} | undefined;
    const r = box?.textRect;
    if (!r || x < r.left - HIT_PAD || x > r.right + HIT_PAD || y < r.top - HIT_PAD || y > r.bottom + HIT_PAD) {
      continue;
    }
    const data = typeof element.userData === 'string' ? element.userData : '';
    log(
      `tap: over #${String(element.numInPage)} "${String(box?.textContentFull ?? '').slice(0, 20)}" ` +
        `userData=${data ? `${data.length} chars starting "${data.slice(0, 24)}"` : 'NONE'}`,
    );
  }

  const icon = elements.find(element => {
    const data = typeof element.userData === 'string' ? element.userData : '';
    const box = element.textBox as {textRect?: Rect} | undefined;
    const r = box?.textRect;
    return (
      data.startsWith(ICON_MARK) &&
      r != null &&
      x >= r.left - HIT_PAD &&
      x <= r.right + HIT_PAD &&
      y >= r.top - HIT_PAD &&
      y <= r.bottom + HIT_PAD
    );
  });
  if (!icon) {
    log('tap: nothing of ours under it');
    return;
  }

  let carried: {id: string; text: string};
  try {
    carried = JSON.parse(String(icon.userData).slice(ICON_MARK.length));
  } catch {
    log('expandable: an icon of ours carries something unreadable');
    return;
  }

  const openMark = `${OPEN_MARK}${carried.id}`;
  const open = elements.find(element => element.userData === openMark);
  const before = await census(path, page, `tap on ${carried.id}: before`);

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
