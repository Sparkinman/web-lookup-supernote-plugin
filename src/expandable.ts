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
  const rect: Rect = {left, top, right: left + ICON_SIZE, bottom: top + ICON_SIZE};

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

  const after = await census(path, page, 'after');
  if (after >= 0 && after < before + 1) {
    log(`expandable: WARNING the page went from ${before} to ${after} elements`);
    return `the page lost content (${before} elements before, ${after} after) — tell me before doing anything else`;
  }
  log(`expandable: page went from ${before} to ${after} elements, as expected`);
  return null;
}
