/**
 * Turning a selection into a search query.
 *
 * Three things can start a lookup: a lasso on a NOTE page, a text selection in
 * DOC, or the user writing a query into the panel by hand. The first two are
 * here; they differ only in where the words come from.
 */

import {PluginCommAPI, PluginDocAPI, PluginNoteAPI} from 'sn-plugin-lib';

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
    const textBoxes = unwrap<{textContentFull?: string | null}[]>(
      await PluginNoteAPI.getLassoText(),
      'getLassoText',
    );
    for (const box of textBoxes) {
      // The field is textContentFull, not `text`.
      const value = box?.textContentFull;
      if (value) {
        typed.push(value);
      }
    }
  } catch {
    // DOC has no note text boxes; fall through to recognition.
  }

  if (typed.length > 0) {
    return clamp(normalize(typed.join(' ')));
  }

  const elements = unwrap<object[]>(await PluginCommAPI.getLassoElements(), 'getLassoElements');
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
    await PluginCommAPI.getPageDisplaySize(),
    'getPageDisplaySize',
  );

  const recognized = unwrap<string>(
    await PluginCommAPI.recognizeElements(elements, size),
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
    await PluginDocAPI.getLastSelectedText(),
    'getLastSelectedText',
  );
  const query = clamp(normalize(selected));
  if (!query) {
    throw new Error('No text selected.');
  }
  return query;
}

/** Where a lookup was started from, so a result can be written back to it. */
export interface SourceRef {
  path: string;
  page: number;
}

export async function currentSource(): Promise<SourceRef> {
  const path = unwrap<string>(await PluginCommAPI.getCurrentFilePath(), 'getCurrentFilePath');
  const page = unwrap<number>(await PluginCommAPI.getCurrentPageNum(), 'getCurrentPageNum');
  return {path, page};
}
