/**
 * Where a clipping's words actually live.
 *
 * The obvious home is the icon element's own `userData`, so that a clipping
 * travels inside the note file. That does not work on this device: an element
 * written with sixty-eight characters of `userData` reads back carrying
 * `uuid, type, layerNum, maxX, pageNum, thickness, maxY, recognizeResult,
 * numInPage, textBox, status, contoursSrc, angles` -- no `userData` at all,
 * whether it is set before the text box or after it, and whether it is read by
 * `getElements` or by `getElement`. The field is declared in the SDK model and
 * silently discarded by the firmware.
 *
 * So the words live here instead, beside the settings, and the icon on the page
 * is identified by where it sits. A rectangle survives the round trip exactly:
 * an icon written at 454,1177 reads back at 454,1177. That is enough to tell
 * our pencil from anything else on the page.
 *
 * The cost of this choice is that a clipping does not follow its note onto
 * another device -- the icon would still be there, and would no longer open.
 * That is worth saying plainly rather than hiding, and it is the firmware's
 * choice, not ours: nothing a plugin can attach to an element persists.
 */

import {NativeModules} from 'react-native';

import type {Rect} from './capture';
import {log} from './log';

interface SettingsNative {
  read(): Promise<string | null>;
  write(contents: string): Promise<string>;
}

const native: SettingsNative | undefined = NativeModules.LookUpSettings;

/** The key the clippings live under, beside the settings in the same blob. */
const KEY = 'clippings';

/** Enough for a page of prose, and a bound on what one tap can cost. */
const MAX_TEXT = 8000;

/** Old clippings are dropped rather than growing the blob without limit. */
const MAX_CLIPPINGS = 300;

/** How far from a stored rectangle a tap still counts as being on it. */
const SLOP = 40;

export interface Clipping {
  id: string;
  /** The note this belongs to, and the page within it. */
  path: string;
  page: number;
  /** Where the icon sits. The whole means of finding it again. */
  rect: Rect;
  /** What the icon reads, so it can be recognised after it has been moved. */
  label: string;
  /** The words the icon carries. */
  text: string;
  /** Where the opened text sits, while it is open. Absent when shut. */
  openRect?: Rect;
  /**
   * Exactly what was written into the opened box.
   *
   * The rectangle alone is not enough to find it again: moving the pencil
   * while it is open leaves the text where it was, and shutting by rectangle
   * then deletes nothing and abandons it on the page. Matching what it says
   * finds it wherever it has ended up.
   */
  openText?: string;
}

async function readAll(): Promise<Record<string, unknown>> {
  if (!native) {
    return {};
  }
  try {
    const raw = await native.read();
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch (err) {
    log(`clippings: could not read (${err instanceof Error ? err.message : String(err)})`);
    return {};
  }
}

/**
 * Change the clippings without touching anything else in the blob.
 *
 * Always a read-modify-write of the file as it is now, never of a copy held in
 * memory: the settings screen writes the same blob, and a stale copy would
 * silently drop whichever of the two was saved first.
 */
async function mutate(change: (list: Clipping[]) => Clipping[]): Promise<void> {
  if (!native) {
    return;
  }
  try {
    const blob = await readAll();
    const existing = Array.isArray(blob[KEY]) ? (blob[KEY] as Clipping[]) : [];
    blob[KEY] = change(existing).slice(-MAX_CLIPPINGS);
    await native.write(JSON.stringify(blob, null, 2));
  } catch (err) {
    log(`clippings: could not save (${err instanceof Error ? err.message : String(err)})`);
  }
}

export async function allClippings(): Promise<Clipping[]> {
  const blob = await readAll();
  return Array.isArray(blob[KEY]) ? (blob[KEY] as Clipping[]) : [];
}

export async function addClipping(clipping: Clipping): Promise<void> {
  const trimmed: Clipping = {...clipping, text: clipping.text.slice(0, MAX_TEXT)};
  await mutate(list => [...list.filter(c => c.id !== trimmed.id), trimmed]);
  log(`clippings: kept ${trimmed.id} for ${trimmed.path} page ${trimmed.page}`);
}

export async function updateClipping(id: string, patch: Partial<Clipping>): Promise<void> {
  await mutate(list => list.map(c => (c.id === id ? {...c, ...patch} : c)));
}

export async function removeClipping(id: string): Promise<void> {
  await mutate(list => list.filter(c => c.id !== id));
}

function within(rect: Rect | undefined, x: number, y: number): boolean {
  return (
    rect != null &&
    x >= rect.left - SLOP &&
    x <= rect.right + SLOP &&
    y >= rect.top - SLOP &&
    y <= rect.bottom + SLOP
  );
}

/** Every clipping belonging to this note, whichever page it was made on. */
export async function clippingsInNote(path: string): Promise<Clipping[]> {
  return (await allClippings()).filter(c => c.path === path);
}

/** Whichever clipping's icon is under the finger, if any. */
export async function clippingAt(
  path: string,
  page: number,
  x: number,
  y: number,
): Promise<Clipping | null> {
  const list = await allClippings();
  const here = list.filter(c => c.path === path && c.page === page);
  // The newest wins, so an icon placed over an abandoned one still opens.
  for (let i = here.length - 1; i >= 0; i -= 1) {
    if (within(here[i].rect, x, y)) {
      return here[i];
    }
  }
  return null;
}
