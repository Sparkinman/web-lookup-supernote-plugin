/**
 * Turning what was read into something the note can point at.
 *
 * The plugin cannot screenshot a web page and does not need to: it fetched the
 * text, so a clipping is drawn rather than captured. The drawing is a PNG, and
 * a link of type 3 opens an image — so tapping the original handwriting later
 * pops the clipping up, with nothing running to serve it.
 */

import {NativeModules} from 'react-native';
import {PluginNoteAPI} from 'sn-plugin-lib';

import type {Anchor, Rect} from './capture';
import type {CaptureMode} from './settings';
import {log} from './log';
import {hostOf} from './url';

/**
 * A drawn PNG and the size it was drawn at.
 *
 * The size matters because a picture element placed in a note must never be
 * scaled beyond the file's natural dimensions -- doing so does not clip or
 * blur, it takes the note app down.
 */
export interface Drawn {
  path: string;
  width: number;
  height: number;
}

interface ClipNative {
  render(
    name: string,
    title: string,
    source: string,
    sectionsJson: string,
    folder: string,
  ): Promise<Drawn>;
  captureView(tag: number, name: string, folder: string): Promise<Drawn>;
}

const native: ClipNative | undefined = NativeModules.LookUpClip;

export const CLIP_AVAILABLE = Boolean(native);

/** Link type 3 opens an image; 4 opens a URL. */
const LINK_TYPE_IMAGE = 3;
const LINK_TYPE_URL = 4;

/**
 * The two labels written under the handwriting.
 *
 * A clipping is a flat image, so the addresses printed inside it cannot be
 * tapped. These are the real links: one to the page as it stands now, one to
 * what was saved from it.
 */
const PAGE_LABEL = 'Source URL';

/**
 * Label height bounds, in pixels, either side of the size derived from the lasso.
 *
 * The ceiling is lower than it would be for a one-word label: these read as
 * whole phrases, so the same height makes them several hundred pixels wide, and
 * a caption under a large lasso would otherwise be wider than the writing it
 * belongs to.
 */
const MIN_LABEL = 34;
const MAX_LABEL = 54;

interface LooseResponse<T> {
  success?: boolean;
  result?: T | null;
  error?: {message?: string} | null;
}

export interface ClipSection {
  /** The result's title, or a heading from the article. */
  heading: string;
  /** Where this passage came from, printed under its heading. */
  url: string;
  /** The passage itself. */
  body: string;
}

export interface ClipRequest {
  /** What to leave in the note: the picture, the link, or both. */
  mode: CaptureMode;
  /** Heading of the clipping — the page or search it came from. */
  title: string;
  /** Where it came from, shown small under the heading. */
  source: string;
  /** The passages, each carrying its own origin. */
  sections: ClipSection[];
  /**
   * Every page the selection points at, one link each.
   *
   * Choosing three results and getting a single link back loses two of them:
   * which one survived was arbitrary, and the other two were only recoverable
   * by reading them off the picture.
   */
  sourceUrls: string[];
  /** What the link to the saved clipping is called on the page. */
  notesLabel: string;
  /** Where the drawn image is written, from settings. */
  folder: string;
  /**
   * Whether to draw the clipping at all.
   *
   * False once an icon on the page carries the same words: a picture of them
   * as well would be a second copy to keep in step with the first.
   */
  drawPicture?: boolean;
}

/**
 * Draw the clipping from the passages, then link to it.
 *
 * Returns null on success, or a reason.
 */
export async function attachClip(
  anchor: Anchor,
  request: ClipRequest,
): Promise<string | null> {
  const refusal = refuse(anchor);
  if (refusal) {
    return refusal;
  }
  if (request.mode === 'link' || request.drawPicture === false) {
    // Nothing to draw: the user has asked for a link to the page and no picture
    // of it, so drawing one would leave an orphaned file behind.
    return attachImage(anchor, null, request.sourceUrls, request.notesLabel);
  }
  let drawn: Drawn;
  try {
    drawn = await native!.render(
      `clip-${Date.now()}`,
      request.title,
      request.source,
      JSON.stringify(request.sections),
      request.folder,
    );
  } catch (err) {
    return err instanceof Error ? err.message : 'the clipping could not be drawn';
  }
  return attachImage(
    anchor,
    drawn.path,
    request.mode === 'png' ? [] : request.sourceUrls,
    request.notesLabel,
  );
}

/**
 * Photograph the reader as it stands, then link to that.
 *
 * For when the shape of what is on screen carries meaning that the passages
 * alone would lose.
 */
export async function attachScreenshot(
  anchor: Anchor,
  viewTag: number,
  sourceUrls: string[],
  mode: CaptureMode,
  notesLabel: string,
  folder: string,
): Promise<string | null> {
  const refusal = refuse(anchor);
  if (refusal) {
    return refusal;
  }
  if (mode === 'link') {
    return attachImage(anchor, null, sourceUrls, notesLabel);
  }
  let drawn: Drawn;
  try {
    drawn = await native!.captureView(viewTag, `shot-${Date.now()}`, folder);
  } catch (err) {
    return err instanceof Error ? err.message : 'the screen could not be captured';
  }
  return attachImage(anchor, drawn.path, mode === 'png' ? [] : sourceUrls, notesLabel);
}

/** The conditions both routes share. */
function refuse(anchor: Anchor): string | null {
  if (!native) {
    return 'the clip module did not load';
  }
  if (!anchor.isNote) {
    // Documents accept neither text boxes nor links, so there is nowhere in a
    // PDF or an EPUB to put either of these.
    return 'a document cannot hold links — open this from a note to keep it';
  }
  if (!anchor.rect) {
    return 'no selection rectangle was captured to hang the links from';
  }
  return null;
}

/**
 * Put two links under the handwriting: the live page, and the saved image.
 *
 * Two rather than one, and beneath the writing rather than on it: the writing
 * itself can only carry a single destination, and the two things wanted here
 * are different — the page as it is now, and what was kept from it. The labels
 * say what they open rather than showing the address, which on a search result
 * is unreadably long.
 */
async function attachImage(
  anchor: Anchor,
  imagePath: string | null,
  sourceUrls: string[],
  imageLabel: string,
): Promise<string | null> {
  const pages = tidy(sourceUrls);
  if (pages.length === 0 && !imagePath) {
    return 'there was no page address to link to';
  }

  // One label per page, named by its host when there are several: "Open link"
  // three times over would say nothing about which is which.
  const pageLabels = pages.map(page => (pages.length === 1 ? PAGE_LABEL : shortHost(page)));
  const labels = [...pageLabels, ...(imagePath ? [imageLabel] : [])];
  const slots = layout(anchor, labels);

  let placed = 0;
  const failures: string[] = [];

  // Indexed by position rather than by how many have succeeded: a failure used
  // to leave the next label reusing the same slot, which drew them on top of
  // each other.
  for (let i = 0; i < pages.length; i++) {
    const failure = await placeLink(slots[i], {
      destPath: pages[i],
      linkType: LINK_TYPE_URL,
      label: pageLabels[i],
    });
    if (failure) {
      failures.push(failure);
    } else {
      placed += 1;
    }
  }

  if (imagePath) {
    const imageFailure = await placeLink(slots[pages.length], {
      destPath: imagePath,
      linkType: LINK_TYPE_IMAGE,
      label: imageLabel,
    });
    if (imageFailure) {
      return [...failures, imageFailure].join('; ');
    }
  } else if (failures.length === pages.length) {
    // Nothing landed at all.
    return failures.join('; ');
  }

  await save();
  if (failures.length > 0) {
    log(`clip: ${failures.length} page link(s) failed — ${failures.join('; ')}`);
  }
  log(`clip: placed ${placed + (imagePath ? 1 : 0)} link(s)`);
  return null;
}

/**
 * Distinct web addresses, in order, capped.
 *
 * A selection of a whole result list would otherwise put ten links under the
 * writing and bury the page it was written on.
 */
function tidy(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) {
      continue;
    }
    seen.add(url);
    out.push(url);
    if (out.length >= MAX_PAGE_LINKS) {
      log(`clip: more than ${MAX_PAGE_LINKS} addresses chosen, keeping the first ${MAX_PAGE_LINKS}`);
      break;
    }
  }
  return out;
}

/** A host short enough to read as a label. */
function shortHost(url: string): string {
  const host = hostOf(url).replace(/^www\./i, '');
  if (!host) {
    return PAGE_LABEL;
  }
  return host.length > MAX_HOST ? `${host.slice(0, MAX_HOST - 1)}…` : host;
}

/** Beyond this many the labels crowd out the page they sit on. */
const MAX_PAGE_LINKS = 6;
const MAX_HOST = 24;

/** Where the labels sit: a row beneath the writing, left-aligned with it. */
function layout(anchor: Anchor, labels: string[]): Rect[] {
  const rect = anchor.rect!;
  const pageWidth = anchor.pageSize?.width ?? 1920;
  const pageHeight = anchor.pageSize?.height ?? 2560;

  // Sized from the writing, the way a caption is: a label in a fixed size looks
  // wrong under both a scrawled word and half a page of writing.
  const height = Math.max(MIN_LABEL, Math.min(MAX_LABEL, Math.round((rect.bottom - rect.top) / 2)));
  const fontSize = Math.round(height * 0.62);

  const slots: Rect[] = [];
  let left = rect.left;
  // Below the writing, tight enough to read as belonging to it.
  let top = Math.min(rect.bottom + GAP, pageHeight - height - GAP);

  for (const label of labels) {
    // The device reports no text metrics, so the width is estimated generously.
    // Too wide costs nothing; too narrow wraps the label onto a second line.
    const width = Math.round(fontSize * label.length * 0.62) + fontSize;
    if (left + width > pageWidth - GAP) {
      // Ran out of room across: start another row rather than run off the page.
      left = rect.left;
      top = Math.min(top + height + GAP, pageHeight - height - GAP);
    }
    slots.push({left, top, right: left + width, bottom: top + height});
    left += width + GAP;
  }
  return slots.map(slot => ({...slot, fontSize} as Rect & {fontSize: number}));
}

interface LinkSpec {
  destPath: string;
  linkType: number;
  label: string;
}

/** Place one labelled link. Null on success. */
async function placeLink(
  slot: (Rect & {fontSize?: number}) | undefined,
  spec: LinkSpec,
): Promise<string | null> {
  if (!slot) {
    return 'there was no room for the link';
  }
  try {
    const response = (await PluginNoteAPI.insertTextLink({
      destPath: spec.destPath,
      destPage: 0,
      style: 0,
      linkType: spec.linkType,
      rect: {left: slot.left, top: slot.top, right: slot.right, bottom: slot.bottom},
      fontSize: slot.fontSize ?? 32,
      fullText: spec.label,
      showText: spec.label,
      isItalic: 0,
    })) as LooseResponse<boolean> | null | undefined;

    if (!response?.success) {
      const why = response?.error?.message ?? 'the device refused the link';
      log(`clip: ${spec.label} refused — ${why} (type ${spec.linkType})`);
      return why;
    }
    // Deliberately no check on `result`: insertTextLink is documented as
    // returning APIResponse<number>, and testing it for `true` reported every
    // successful insert as a failure — the links were on the page while the
    // panel said it had failed, and the failure path put both labels in the
    // same slot on top of each other.
    log(`clip: placed ${spec.label} -> ${spec.destPath}`);
    return null;
  } catch (err) {
    const why = err instanceof Error ? err.message : 'an unknown error';
    log(`clip: ${spec.label} threw — ${why}`);
    return why;
  }
}

/**
 * Write the passages into the page as a text box, below the writing.
 *
 * `insertText` takes a described box, not a string: passing bare text is
 * accepted and does nothing at all, with no error — which looks exactly like a
 * dead button. The rectangle is required and must have area.
 *
 * The text is headed by where it came from: the file and page the lookup
 * started on, then the address of the page it was read from. Neither is
 * clickable inside a text box, and both are still worth having — a quote whose
 * source has to be reconstructed from memory is a quote you cannot use.
 *
 * Returns null on success, or a reason.
 */
export async function insertPassages(
  anchor: Anchor,
  passages: string,
  origin: {reference: string; urls: string[]},
): Promise<string | null> {
  const rect = anchor.rect;
  const pageWidth = anchor.pageSize?.width ?? 1920;
  const pageHeight = anchor.pageSize?.height ?? 2560;

  // Headed by the book or note it was looked up from, then every address the
  // selection came from. Read a month later, "which book was I reading" is the
  // first question, and it is the one thing that cannot be recovered from the
  // text itself.
  const header = [origin.reference, ...tidy(origin.urls)].filter(Boolean).join('\n');
  const text = header ? `${header}\n\n${passages}` : passages;

  const fontSize = 40;
  const left = rect ? Math.min(rect.left, pageWidth - MIN_TEXT_WIDTH - MARGIN) : MARGIN;
  const right = pageWidth - MARGIN;
  const top = rect ? rect.bottom + GAP * 2 : MARGIN;

  // The device reports no text metrics, so the height is estimated from an
  // average character width. Too tall costs nothing — the box has no border —
  // while too short clips the tail of the quote.
  const perLine = Math.max(10, Math.floor((right - left) / (fontSize * 0.5)));
  const lines = text.split('\n').reduce(
    (total, line) => total + Math.max(1, Math.ceil(line.length / perLine)),
    0,
  );
  const height = Math.round(lines * fontSize * 1.5) + fontSize;
  const bottom = Math.min(pageHeight - MARGIN, top + height);

  if (bottom - top < fontSize) {
    return 'there is no room left on this page below the writing';
  }

  const box = {
    textContentFull: text,
    textRect: {left, top, right, bottom},
    fontSize,
    textAlign: 0,
    textBold: 0,
    textItalics: 0,
    textFrameWidthType: 0,
    textFrameStyle: 0,
    // Editable, so the quote can be trimmed in the note afterwards.
    textEditable: 1,
  };

  /**
   * Try to make it a digest excerpt first.
   *
   * `insertText` accepts a `textDigestData` string, and that field is what
   * separates a digest text box (element types 501 and 502) from a plain one.
   * The SDK documents the field's type and nothing about its contents, so this
   * is a guess — hence the fallback: a refused digest must not cost the user
   * their text, so the same box goes in again without the field.
   */
  const digest = await write({
    ...box,
    textDigestData: JSON.stringify({
      source: anchor.fileName,
      page: anchor.source.page,
      urls: tidy(origin.urls),
    }),
  });
  if (digest === null) {
    log(`insert: wrote ${text.length} characters as a digest excerpt`);
    await save();
    return null;
  }

  log(`insert: digest refused (${digest}), writing a plain text box instead`);
  if (!anchor.isNote) {
    // A document takes no plain text box at all, so there is nothing left to
    // try. Reported rather than retried, since the retry is certain to fail.
    return `this document would not take the excerpt (${digest})`;
  }
  const plain = await write(box);
  if (plain !== null) {
    return plain;
  }
  log(`insert: wrote ${text.length} characters below the writing`);
  await save();
  return null;
}

/** One insertText attempt. Null on success. */
async function write(box: object): Promise<string | null> {
  try {
    const response = (await PluginNoteAPI.insertText(box)) as
      | LooseResponse<boolean>
      | null
      | undefined;
    if (!response?.success) {
      return response?.error?.message ?? 'the device refused the text';
    }
    if (response.result !== true) {
      return 'the device accepted the text but wrote nothing';
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'an unknown error';
  }
}

const MARGIN = 60;
const MIN_TEXT_WIDTH = 400;

/** Space between the writing and anything placed next to or under it, in pixels. */
const GAP = 14;

/**
 * Persist the page.
 *
 * Separate from each insert so a clipping that places two links saves once,
 * rather than leaving a half-written page if the second one fails.
 */
async function save(): Promise<void> {
  try {
    await PluginNoteAPI.saveCurrentNote();
  } catch (err) {
    log(`clip: save failed ${err instanceof Error ? err.message : String(err)}`);
  }
}

