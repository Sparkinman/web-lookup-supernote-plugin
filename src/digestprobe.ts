/**
 * Reading a real digest back off the device.
 *
 * A digest text box is what the firmware writes when somebody drags a passage
 * out of a book, and the field that makes it one -- `textDigestData` -- is
 * undocumented. Guessing its contents produced text boxes that carried a digest
 * type number and behaved like nothing at all, so the format has to be read
 * from an example the device wrote itself.
 *
 * An earlier attempt at this looked only at `getLassoText`, which comes back
 * empty for these, and logged `getLassoElements` truncated -- so on the one
 * occasion a digest was almost certainly selected, the evidence was thrown away
 * by the instrument meant to capture it. This reads the whole page instead of a
 * selection, so nothing has to be lassoed accurately, and prints the field
 * whole.
 */

import {PluginFileAPI} from 'sn-plugin-lib';

import {log} from './log';

interface LooseResponse<T> {
  success?: boolean;
  result?: T | null;
  error?: {message?: string} | null;
}

/** Element types the firmware uses for digest text boxes. */
const DIGEST_TYPES = [501, 502];

/**
 * Decode base64 without a platform helper.
 *
 * Hermes has no `atob`, and Supernote encodes its other back-references --
 * the link from a task to the note it was written on -- as base64 around JSON.
 * If `textDigestData` is the same shape, decoding it on the device makes the
 * log readable rather than a wall of padding.
 */
function fromBase64(input: string): string | null {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = input.replace(/[^A-Za-z0-9+/=]/g, '');
  if (!clean || clean.length % 4 !== 0) {
    return null;
  }
  let bits = '';
  let out = '';
  for (const character of clean) {
    if (character === '=') {
      break;
    }
    const index = alphabet.indexOf(character);
    if (index < 0) {
      return null;
    }
    bits += index.toString(2).padStart(6, '0');
  }
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    out += String.fromCharCode(parseInt(bits.slice(i, i + 8), 2));
  }
  return out;
}

/** Log one API answer whole, error included, without deciding what it means. */
function report(label: string, response: unknown): void {
  const parsed = response as LooseResponse<unknown> | null | undefined;
  if (parsed?.success) {
    log(`probe: ${label} ok ${JSON.stringify(parsed.result).slice(0, 1200)}`);
  } else {
    log(`probe: ${label} refused ${JSON.stringify(parsed?.error ?? parsed ?? null)}`);
  }
}

/** Log a digest payload every way it might be readable. */
function describe(label: string, raw: string): void {
  log(`${label} RAW: ${raw}`);
  try {
    log(`${label} AS JSON: ${JSON.stringify(JSON.parse(raw))}`);
    return;
  } catch {
    // Not plain JSON; try the encoding Supernote uses elsewhere.
  }
  const decoded = fromBase64(raw);
  if (decoded) {
    log(`${label} BASE64-DECODED: ${decoded}`);
  } else {
    log(`${label} is neither JSON nor base64`);
  }
}

/**
 * Look over one page of a note for anything the firmware calls a digest.
 *
 * Quiet when there is nothing to find, and quiet when the page cannot be read
 * -- which is the case whenever a book is the app in front. Nothing here
 * changes the note.
 */
export async function probePage(notePath: string, page: number): Promise<void> {
  try {
    const response = (await PluginFileAPI.getElements(page, notePath)) as
      | LooseResponse<Record<string, unknown>[]>
      | null
      | undefined;
    if (!response?.success || !Array.isArray(response.result)) {
      log(`probe: page ${page} of ${notePath} -> ${JSON.stringify(response?.error ?? null)}`);
      return;
    }

    const elements = response.result;
    const types = elements.map(element => element?.type).join(',');
    log(`probe: page ${page} has ${elements.length} element(s), types [${types}]`);

    let found = 0;
    for (const element of elements) {
      const type = Number(element?.type);
      const box = element?.textBox as Record<string, unknown> | undefined;
      const data = typeof box?.textDigestData === 'string' ? box.textDigestData : '';
      if (!DIGEST_TYPES.includes(type) && !data) {
        continue;
      }
      found += 1;
      log(
        `probe: DIGEST ELEMENT type=${type} frameStyle=${String(box?.textFrameStyle)} ` +
          `editable=${String(box?.textEditable)} align=${String(box?.textAlign)} ` +
          `frameWidthType=${String(box?.textFrameWidthType)} fontSize=${String(box?.fontSize)}`,
      );
      log(`probe: DIGEST TEXT: ${String(box?.textContentFull ?? '').slice(0, 200)}`);
      log(`probe: DIGEST RECT: ${JSON.stringify(box?.textRect ?? null)}`);
      if (data) {
        describe('probe: DIGEST DATA', data);
      } else {
        log('probe: this digest element carries no textDigestData at all');
      }
      // The link that jumps back to the source is a separate element; log any
      // link on the page too, since type 6 is documented as the digest link.
    }

    for (const element of elements) {
      const link = element?.link as Record<string, unknown> | undefined;
      if (link) {
        log(`probe: LINK linkType=${String(link.linkType)} destPath=${String(link.destPath)} destPage=${String(link.destPage)} showText=${String(link.showText)}`);
      }
    }

    if (found === 0) {
      log('probe: no digest elements on this page');
    }
  } catch (err) {
    log(`probe: threw — ${err instanceof Error ? err.message : String(err)}`);
  }
}


/**
 * Look for a book's own markup, which is where a digest taken from a book lives.
 *
 * A digest dragged out of a PDF is not an element of any note -- it belongs to
 * the document, and Supernote keeps a document's annotations in a mark file
 * beside it. So the note-side probe was looking in a place these could never
 * be. This asks the document instead.
 *
 * Every answer is logged whole, refusals included, because the second question
 * here is whether these calls are gated on the foreground app the way the
 * note-side ones are. If they are, a book's own markup is out of reach too and
 * the local route is finished; if they are not, the format is right there.
 */
export async function probeBook(bookPath: string, page: number): Promise<void> {
  log(`probe: looking at the book ${bookPath} page ${page}`);

  const markPath = `${bookPath}.mark`;
  let marked: number[] = [];
  try {
    const response = (await PluginFileAPI.getMarkPages(bookPath)) as
      | LooseResponse<number[]>
      | null
      | undefined;
    if (response?.success && Array.isArray(response.result)) {
      marked = response.result;
      log(`probe: getMarkPages ok ${JSON.stringify(marked)}`);
    } else {
      log(`probe: getMarkPages refused ${JSON.stringify(response?.error ?? null)}`);
    }
  } catch (err) {
    log(`probe: getMarkPages threw — ${err instanceof Error ? err.message : String(err)}`);
  }

  /**
   * Which numbers to try as the page argument.
   *
   * The document's own page number returned nothing on a page that
   * getMarkPages says is marked, so the argument is probably an index into the
   * mark file rather than into the document -- the list is what the mark file
   * holds, in order, and the page wanted sits at some position in it. Both are
   * tried, along with the first entry as a control: if index 0 answers and the
   * document number does not, that settles which one this argument means.
   */
  const at = marked.indexOf(page);
  const attempts: {label: string; index: number}[] = [
    {label: `document page ${page}`, index: page},
  ];
  if (at >= 0) {
    attempts.push({label: `mark index ${at} (page ${page})`, index: at});
  }
  if (marked.length > 0) {
    attempts.push({label: 'mark index 0 (control)', index: 0});
  }

  for (const attempt of attempts) {
    for (const [label, path] of [
      ['book', bookPath],
      ['mark', markPath],
    ] as const) {
      try {
        const response = (await PluginFileAPI.getElements(attempt.index, path)) as
          | LooseResponse<Record<string, unknown>[]>
          | null
          | undefined;
        if (!response?.success || !Array.isArray(response.result)) {
          log(
            `probe: getElements(${label}, ${attempt.label}) refused ` +
              `${JSON.stringify(response?.error ?? null)}`,
          );
          continue;
        }
        const elements = response.result;
        log(
          `probe: getElements(${label}, ${attempt.label}) returned ${elements.length}, ` +
            `types [${elements.map(e => e?.type).join(',')}]`,
        );
        for (const element of elements) {
          const box = element?.textBox as Record<string, unknown> | undefined;
          const link = element?.link as Record<string, unknown> | undefined;
          if (box) {
            log(`probe: TEXT BOX (${label}) ${JSON.stringify(box).slice(0, 900)}`);
            const data = typeof box.textDigestData === 'string' ? box.textDigestData : '';
            if (data) {
              describe(`probe: DIGEST DATA (${label})`, data);
            }
          }
          if (link) {
            log(`probe: LINK (${label}) ${JSON.stringify(link).slice(0, 500)}`);
          }
        }
      } catch (err) {
        log(
          `probe: getElements(${label}, ${attempt.label}) threw — ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Counts take their arguments the other way round from getElements, which is
  // worth exercising separately in case only one of the two is index-based.
  for (const attempt of attempts) {
    try {
      report(
        `getElementCounts(${attempt.label})`,
        await PluginFileAPI.getElementCounts(bookPath, attempt.index),
      );
    } catch (err) {
      log(`probe: getElementCounts threw — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
