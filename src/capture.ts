/**
 * Turning a selection into a search query.
 *
 * Three things can start a lookup: a lasso on a NOTE page, a text selection in
 * DOC, or the user writing a query into the panel by hand. The first two are
 * here; they differ only in where the words come from.
 */

import {PluginCommAPI, PluginDocAPI, PluginNoteAPI} from 'sn-plugin-lib';

import {log, step} from './log';

/**
 * Most PluginCommAPI methods are declared `Promise<Object | null | undefined>`
 * rather than APIResponse<T>, so the response shape has to be narrowed by hand.
 * APIResponse itself uses `result: T | null` and `error: APIResponseError | null`
 * — both nullable, neither optional.
 */
interface LooseResponse<T> {
  success?: boolean;
  result?: T | null;
  error?: {message?: string} | null;
}

function unwrap<T>(res: unknown, what: string): T {
  const parsed = res as LooseResponse<T> | null | undefined;
  if (!parsed?.success || parsed.result === null || parsed.result === undefined) {
    throw new Error(`${what} failed: ${parsed?.error?.message ?? 'unknown error'}`);
  }
  return parsed.result;
}

/**
 * Collapse recognition output onto one line.
 *
 * Handwriting recognised across several lines comes back with the line breaks
 * intact, which is right for a note and wrong for a search box.
 */
export function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * A query is only useful up to a point — a whole paragraph lassoed by accident
 * makes a worse search than the first few words of it, and a very long string
 * risks being rejected by whatever ends up serving the lookup.
 */
const MAX_QUERY = 200;

function clamp(text: string): string {
  return text.length > MAX_QUERY ? text.slice(0, MAX_QUERY).trimEnd() : text;
}

/**
 * Read the current lasso selection as a search query.
 *
 * Typed text is preferred over handwriting: a text box already carries an exact
 * string, so running it through the recogniser could only make it worse.
 */
export async function readLassoAsQuery(): Promise<string> {
  const typed: string[] = [];

  try {
    const textBoxes = unwrap<
      {textContentFull?: string | null; textDigestData?: string | null}[]
    >(
      await step('getLassoText', () => PluginNoteAPI.getLassoText()),
      'getLassoText',
    );
    for (const box of textBoxes) {
      // The field is textContentFull, not `text`.
      const value = box?.textContentFull;
      if (value) {
        typed.push(value);
      }
      // Logged in full, untruncated, because its format is undocumented.
      // `insertText` accepts a textDigestData string, which is what turns a
      // plain text box into a digest excerpt (element type 501/502) — but the
      // SDK never says what belongs in it. One real example read back off the
      // device settles it.
      if (box?.textDigestData) {
        log(`DIGEST DATA: ${box.textDigestData}`);
      }
    }
  } catch {
    // DOC has no note text boxes; fall through to recognition.
  }

  if (typed.length > 0) {
    return clamp(normalize(typed.join(' ')));
  }

  const elements = unwrap<object[]>(
    await step('getLassoElements', () => PluginCommAPI.getLassoElements()),
    'getLassoElements',
  );
  if (elements.length === 0) {
    throw new Error('Nothing selected.');
  }

  // getPageDisplaySize is the current-page equivalent of PluginFileAPI.getPageSize
  // and — unlike getPageSize — is not FILE:READ-gated, so this path keeps working
  // without declaring a file permission the plugin does not otherwise need.
  //
  // The recogniser wants the size of the whole page, NOT the lasso bounding rect.
  // Passing the rect makes the firmware throw `unknown pageSize` and recognition
  // fails outright.
  const size = unwrap<{width: number; height: number}>(
    await step('getPageDisplaySize', () => PluginCommAPI.getPageDisplaySize()),
    'getPageDisplaySize',
  );

  const recognized = unwrap<string>(
    await step('recognizeElements', () => PluginCommAPI.recognizeElements(elements, size)),
    'recognizeElements',
  );

  const query = clamp(normalize(recognized));
  if (!query) {
    throw new Error('Could not read any text from that selection.');
  }
  return query;
}

/**
 * Read the current DOC text selection as a search query.
 *
 * `getLastSelectedText` returns the most recent selection even once it has been
 * dismissed, which matters because opening the plugin view can clear the
 * on-screen selection before this runs.
 */
export async function readDocSelectionAsQuery(): Promise<string> {
  const selected = unwrap<string>(
    await step('getLastSelectedText', () => PluginDocAPI.getLastSelectedText()),
    'getLastSelectedText',
  );
  const query = clamp(normalize(selected));
  if (!query) {
    throw new Error('No text selected.');
  }
  return query;
}

/**
 * The query as it should actually be searched, given where it came from.
 *
 * A sentence lifted out of a book frequently means nothing standing alone -- a
 * line of scripture, a term of art, a character's name -- and searching it
 * beside the book's title is the difference between finding the passage and
 * finding a stranger who happened to use the same words. The same context ruins
 * a lookup of a word that only needed defining, which is why this is driven by
 * a setting rather than applied whenever a book is open.
 *
 * Notes are never given the treatment: the file name of a note is a date or a
 * heading, and neither says anything useful about what was written on it.
 */
export function withBookContext(
  query: string,
  anchor: Anchor | null,
  include: boolean,
): string {
  if (!include || !anchor || anchor.isNote || !anchor.fileName) {
    return query;
  }
  return clamp(normalize(`${anchor.fileName} ${query}`));
}

/** Where a lookup was started from, so a result can be written back to it. */
export interface SourceRef {
  path: string;
  page: number;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Everything needed to attach something to the handwriting later.
 *
 * Captured at mount, while the lasso is still live. By the time the reader has
 * been browsed the lasso may well be gone, and `getLassoRect` would then have
 * nothing to report — but `insertTextLink` takes an explicit rectangle, so a
 * rectangle read now still works minutes later.
 */
export interface Anchor {
  source: SourceRef;
  rect: Rect | null;
  /** Page bounds, so anything placed beside the writing stays on the page. */
  pageSize: {width: number; height: number} | null;
  /** The file's own name, cited on the clipping so a lookup keeps its origin. */
  fileName: string;
  /**
   * Whether the lookup started in a note.
   *
   * Documents accept no text boxes and no links, so nothing can be written back
   * into a PDF or an EPUB. Worth knowing before offering the button rather than
   * after the device refuses it.
   */
  isNote: boolean;
}

export async function currentSource(): Promise<SourceRef> {
  const path = unwrap<string>(
    await step('getCurrentFilePath', () => PluginCommAPI.getCurrentFilePath()),
    'getCurrentFilePath',
  );
  const page = unwrap<number>(
    await step('getCurrentPageNum', () => PluginCommAPI.getCurrentPageNum()),
    'getCurrentPageNum',
  );
  return {path, page};
}

/**
 * The lasso's bounds, or null when there is no usable selection.
 *
 * An empty rectangle is treated as no rectangle: `insertTextLink` requires a
 * non-zero area and fails without saying why, so a degenerate rect is worth
 * discarding here rather than passing on.
 */
export async function lassoRect(): Promise<Rect | null> {
  try {
    const rect = unwrap<Rect>(
      await step('getLassoRect', () => PluginCommAPI.getLassoRect()),
      'getLassoRect',
    );
    if (rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0) {
      return null;
    }
    return rect;
  } catch {
    return null;
  }
}

/** Read the anchor while the lasso still exists. */
export async function captureAnchor(): Promise<Anchor> {
  const [source, rect, pageSize] = await Promise.all([
    currentSource(),
    lassoRect(),
    pageDisplaySize(),
  ]);
  return {
    source,
    rect,
    pageSize,
    fileName: baseName(source.path),
    isNote: /\.note$/i.test(source.path),
  };
}

/** The file's name without its directory or extension. */
export function baseName(path: string): string {
  const last = path.split('/').pop() ?? path;
  return last.replace(/\.[^.]+$/, '');
}

/**
 * How a lookup's origin is cited on the clipping.
 *
 * Pages are numbered from zero internally and from one everywhere a person
 * reads them.
 */
export function reference(anchor: Anchor | null): string {
  if (!anchor) {
    return '';
  }
  // Named as a book when it is one: "From Bible, page 3696" reads as a citation,
  // which is what it is, where a bare filename reads as a file path.
  const what = anchor.isNote ? 'note' : 'book';
  return `From ${what} "${anchor.fileName}", page ${anchor.source.page + 1}`;
}

async function pageDisplaySize(): Promise<{width: number; height: number} | null> {
  try {
    return unwrap<{width: number; height: number}>(
      await PluginCommAPI.getPageDisplaySize(),
      'getPageDisplaySize',
    );
  } catch {
    return null;
  }
}
