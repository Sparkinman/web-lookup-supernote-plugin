/**
 * A clipping that lives on the page and opens where it sits.
 *
 * The firmware's own popup is an image link, so what it shows is a picture of
 * the text rather than the text. The alternative is to put the words on the
 * page as a text box, which is real text but takes the room a clipping needs
 * whether or not anybody is reading it.
 *
 * This is the third way, and it is the one Collapse/Expand demonstrates: a
 * small icon carries the words in its own `userData`, and a finger tap on the
 * icon writes them onto the page beside it. Tapping again takes them away. The
 * plugin is never opened, no page is turned, and nothing is left behind but the
 * icon when it is shut.
 *
 * The tap arrives through `registerMotionListener`, which reports touches on
 * the note whether or not the plugin's own view is up. A pen touch is ignored
 * on purpose: a pen is drawing, and reacting to it would fight the person
 * holding it.
 */

import {PluginCommAPI, PluginFileAPI, PluginManager, PluginNoteAPI} from 'sn-plugin-lib';

import type {Anchor, Rect} from './capture';
import {log} from './log';

interface LooseResponse<T> {
  success?: boolean;
  result?: T | null;
  error?: {message?: string} | null;
}

/** Element types, from Element.TYPE_*. */
const TYPE_TEXT = 500;

/** What marks an element as ours, and which of the two it is. */
const ICON_MARK = 'weblookup-icon:';
const OPEN_MARK = 'weblookup-open:';

/** How far outside the icon a tap still counts, in page units. */
const HIT_PAD = 24;

/** The icon's size on the page. Large enough to hit with a finger. */
const ICON_SIZE = 64;
const ICON_FONT = 40;

/** Where the opened text is drawn, and how much room it may take. */
const GAP = 14;
const MARGIN = 60;
const TEXT_FONT = 34;

function unwrap<T>(res: unknown): T | null {
  const parsed = res as LooseResponse<T> | null | undefined;
  return parsed?.success && parsed.result != null ? parsed.result : null;
}

/** Every element on a page, or an empty list when it cannot be read. */
async function elementsOn(notePath: string, page: number): Promise<Record<string, unknown>[]> {
  try {
    const result = unwrap<Record<string, unknown>[]>(
      await PluginFileAPI.getElements(page, notePath),
    );
    return Array.isArray(result) ? result : [];
  } catch (err) {
    log(`expandable: could not read page ${page} (${err instanceof Error ? err.message : String(err)})`);
    return [];
  }
}

function userDataOf(element: Record<string, unknown>): string {
  return typeof element.userData === 'string' ? element.userData : '';
}

function rectOf(element: Record<string, unknown>): Rect | null {
  const box = element.textBox as {textRect?: Rect} | undefined;
  return box?.textRect ?? null;
}

function contains(rect: Rect, x: number, y: number): boolean {
  return (
    x >= rect.left - HIT_PAD &&
    x <= rect.right + HIT_PAD &&
    y >= rect.top - HIT_PAD &&
    y <= rect.bottom + HIT_PAD
  );
}

/** Build a text element of our own, with the mark that says it is ours. */
async function textElement(
  page: number,
  text: string,
  rect: Rect,
  fontSize: number,
  userData: string,
): Promise<Record<string, unknown> | null> {
  try {
    const element = unwrap<Record<string, unknown>>(await PluginCommAPI.createElement(TYPE_TEXT));
    if (!element) {
      return null;
    }
    element.pageNum = page;
    element.layerNum = 0;
    element.userData = userData;
    element.textBox = {
      fontSize,
      textContentFull: text,
      textRect: rect,
      textAlign: 0,
      textBold: 0,
      textItalics: 0,
      textFrameWidthType: 0,
      textFrameStyle: 0,
      textEditable: 0,
    };
    return element;
  } catch (err) {
    log(`expandable: createElement failed (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
}

/**
 * Put the icon on the page, carrying the words it will show.
 *
 * The text rides in `userData` rather than in a file beside the note, so the
 * clipping travels with the page it belongs to: copied, synced or exported, it
 * stays whole.
 */
export async function insertExpandable(
  anchor: Anchor,
  label: string,
  text: string,
  below: number,
): Promise<string | null> {
  if (!anchor.rect) {
    return 'there was no selection to hang it from';
  }
  const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const left = anchor.rect.left;
  const top = Math.min(below, (anchor.pageSize?.height ?? 2560) - ICON_SIZE - GAP);
  const rect: Rect = {left, top, right: left + ICON_SIZE, bottom: top + ICON_SIZE};

  const element = await textElement(
    anchor.source.page,
    label,
    rect,
    ICON_FONT,
    `${ICON_MARK}${JSON.stringify({id, text})}`,
  );
  if (!element) {
    return 'the icon could not be made';
  }

  try {
    const response = (await PluginFileAPI.insertElements(anchor.source.path, anchor.source.page, [
      element,
    ])) as LooseResponse<boolean> | null | undefined;
    if (!response?.success) {
      const why = response?.error?.message ?? 'the device refused it';
      log(`expandable: insert refused — ${why}`);
      return why;
    }
    log(`expandable: icon ${id} placed at ${left},${top} carrying ${text.length} characters`);
    await save();
    return null;
  } catch (err) {
    const why = err instanceof Error ? err.message : 'an unknown error';
    log(`expandable: insert threw — ${why}`);
    return why;
  }
}

async function save(): Promise<void> {
  try {
    await PluginNoteAPI.saveCurrentNote();
  } catch (err) {
    log(`expandable: save failed (${err instanceof Error ? err.message : String(err)})`);
  }
}

/**
 * A finger tap landed. Open or shut whichever clipping is under it.
 *
 * Quiet about everything: a tap that hits nothing of ours is the overwhelming
 * majority of taps, and must cost nothing and say nothing.
 */
export async function tapped(x: number, y: number): Promise<void> {
  const path = unwrap<string>(await PluginCommAPI.getCurrentFilePath());
  const page = unwrap<number>(await PluginCommAPI.getCurrentPageNum());
  if (!path || typeof page !== 'number' || !/\.note$/i.test(path)) {
    return;
  }

  const elements = await elementsOn(path, page);
  const icon = elements.find(element => {
    const data = userDataOf(element);
    const rect = rectOf(element);
    return data.startsWith(ICON_MARK) && rect != null && contains(rect, x, y);
  });
  if (!icon) {
    return;
  }

  let carried: {id: string; text: string};
  try {
    carried = JSON.parse(userDataOf(icon).slice(ICON_MARK.length));
  } catch {
    log('expandable: an icon of ours carries something unreadable');
    return;
  }

  const openMark = `${OPEN_MARK}${carried.id}`;
  const already = elements.find(element => userDataOf(element) === openMark);

  // Shown briefly while the page is changed. Collapse/Expand does the same, and
  // a write attempted without it is refused -- the plugin has to be the app in
  // front to touch the note.
  let shown = false;
  try {
    await PluginManager.showPluginView();
    shown = true;
  } catch (err) {
    log(`expandable: could not raise the view (${err instanceof Error ? err.message : String(err)})`);
  }

  try {
    if (already) {
      const num = Number(already.numInPage);
      log(`expandable: shutting ${carried.id} (element ${num})`);
      await PluginFileAPI.deleteElements(path, page, [num]);
      await save();
      return;
    }
    await open(path, page, icon, carried);
  } catch (err) {
    log(`expandable: toggle failed (${err instanceof Error ? err.message : String(err)})`);
  } finally {
    if (shown) {
      try {
        await PluginManager.closePluginView();
      } catch {
        // Nothing useful to do about it.
      }
    }
  }
}

/** Draw the carried words onto the page, under the icon. */
async function open(
  path: string,
  page: number,
  icon: Record<string, unknown>,
  carried: {id: string; text: string},
): Promise<void> {
  const rect = rectOf(icon);
  if (!rect) {
    return;
  }
  const size = unwrap<{width: number; height: number}>(await PluginFileAPI.getPageSize(path, page));
  const width = size?.width ?? 1920;
  const height = size?.height ?? 2560;

  const left = Math.min(rect.left, width - MARGIN - 400);
  const right = width - MARGIN;
  const top = rect.bottom + GAP;
  // The device reports no text metrics, so the height is estimated from an
  // average character width. Too tall costs nothing -- the box has no border --
  // where too short clips the tail of the clipping.
  const perLine = Math.max(10, Math.floor((right - left) / (TEXT_FONT * 0.5)));
  const lines = carried.text
    .split('\n')
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / perLine)), 0);
  const bottom = Math.min(height - MARGIN, top + Math.round(lines * TEXT_FONT * 1.5) + TEXT_FONT);
  if (bottom - top < TEXT_FONT) {
    log('expandable: no room below the icon to open it');
    return;
  }

  const element = await textElement(
    page,
    carried.text,
    {left, top, right, bottom},
    TEXT_FONT,
    `${OPEN_MARK}${carried.id}`,
  );
  if (!element) {
    return;
  }
  const response = (await PluginFileAPI.insertElements(path, page, [element])) as
    | LooseResponse<boolean>
    | null
    | undefined;
  if (!response?.success) {
    log(`expandable: opening refused — ${response?.error?.message ?? 'no reason given'}`);
    return;
  }
  log(`expandable: opened ${carried.id}`);
  await save();
}
