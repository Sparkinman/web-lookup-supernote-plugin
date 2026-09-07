/**
 * Turning what was read into something the note can point at.
 *
 * The plugin cannot screenshot a web page and does not need to: it fetched the
 * text, so a clipping is drawn rather than captured. The drawing is a PNG, and
 * a link of type 3 opens an image — so tapping the original handwriting later
 * pops the clipping up, with nothing running to serve it.
 */

import {NativeModules} from 'react-native';
import {PluginCommAPI, PluginFileAPI, PluginNoteAPI} from 'sn-plugin-lib';

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
  if (request.mode === 'link') {
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

/**
 * Draw a clipping and hand back the file, without touching any note.
 *
 * Separated from attachClip because a digest entry needs the picture as an
 * element it will place itself, where attachClip needs it as the target of a
 * link. Same drawing, two destinations.
 */
export async function drawClip(request: {
  title: string;
  source: string;
  sections: ClipSection[];
  folder: string;
}): Promise<Drawn | null> {
  if (!native) {
    return null;
  }
  try {
    return await native.render(
      `clip-${Date.now()}`,
      request.title,
      request.source,
      JSON.stringify(request.sections),
      request.folder,
    );
  } catch (err) {
    log(`digest: clipping could not be drawn (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
}

/**
 * A digest entry for a lookup that started in a book.
 *
 * A book itself takes nothing: every PluginNoteAPI write is refused outright
 * when the foreground app is DOC, which is what "This app is not allowed to use
 * this API" means. That is not a limit on digests, though -- the firmware's own
 * digest does not write into the PDF either, it collects excerpts into a note.
 * So this does the same thing by the same shape, using PluginFileAPI, whose
 * writes take a path and are not tied to whichever app is in front.
 *
 * Each entry gets its own page carrying three things: a link back to the exact
 * page of the book, the selected text as a digest text box, and the clipping
 * drawn underneath where the handwriting would go.
 *
 * Returns null on success, or a reason.
 */
export async function appendDigest(
  anchor: Anchor,
  notePath: string,
  entry: {reference: string; text: string; urls: string[]; image: Drawn | null},
): Promise<string | null> {
  const page = await freshPage(notePath);
  if (typeof page === 'string') {
    return page;
  }

  const size = await pageSize(notePath, page);
  const width = size.width;
  const height = size.height;
  const elements: object[] = [];

  // Back to the book first, at the top, because it is the one thing that cannot
  // be reconstructed from the rest: the excerpt says what was read, only this
  // says where in the book to stand to read the rest of it.
  const backLabel = truncate(entry.reference, 48);
  const linkBottom = MARGIN + LINK_HEIGHT;
  elements.push({
    type: 600,
    pageNum: page,
    layerNum: 0,
    link: {
      category: 0,
      X: MARGIN,
      Y: MARGIN,
      width: Math.min(width - MARGIN * 2, Math.round(LINK_FONT * backLabel.length * 0.62) + LINK_FONT),
      height: LINK_HEIGHT,
      page,
      style: 0,
      // 2 is a document link. destPage is the book's own page index, so this
      // reopens the PDF where the selection was made rather than at its start.
      linkType: 2,
      destPath: anchor.source.path,
      destPage: anchor.source.page,
      fullText: backLabel,
      showText: backLabel,
      italic: 0,
    },
  });

  // The selection, as a digest quote (501) rather than a plain text box (500),
  // so the note app treats it as an excerpt of something rather than as text
  // someone typed.
  const header = [entry.reference, ...tidy(entry.urls)].filter(Boolean).join('\n');
  const text = header ? `${header}\n\n${entry.text}` : entry.text;
  const textTop = linkBottom + GAP * 2;
  const perLine = Math.max(10, Math.floor((width - MARGIN * 2) / (DIGEST_FONT * 0.5)));
  const lines = text
    .split('\n')
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / perLine)), 0);
  const textBottom = Math.min(
    height - MARGIN,
    textTop + Math.round(lines * DIGEST_FONT * 1.5) + DIGEST_FONT,
  );
  elements.push({
    type: 501,
    pageNum: page,
    layerNum: 0,
    textBox: {
      fontSize: DIGEST_FONT,
      textContentFull: text,
      textRect: {left: MARGIN, top: textTop, right: width - MARGIN, bottom: textBottom},
      textDigestData: JSON.stringify({
        source: anchor.fileName,
        page: anchor.source.page,
        urls: tidy(entry.urls),
      }),
      textAlign: 0,
      textBold: 0,
      textItalics: 0,
      textFrameWidthType: 0,
      textFrameStyle: 0,
      textEditable: 1,
    },
  });

  // The clipping goes below the quote, in what would be the handwriting half of
  // a digest page. Scaled to fit and never past its natural size: a picture
  // element enlarged beyond the file's own dimensions crashes the note app.
  if (entry.image) {
    const top = textBottom + GAP * 2;
    const room = {width: width - MARGIN * 2, height: height - MARGIN - top};
    if (room.height >= MIN_IMAGE_HEIGHT) {
      const scale = Math.min(
        room.width / entry.image.width,
        room.height / entry.image.height,
        1,
      );
      const drawnWidth = Math.floor(entry.image.width * scale);
      const drawnHeight = Math.floor(entry.image.height * scale);
      elements.push({
        // 200, from Element.TYPE_PICTURE. Worth naming because the schema has
        // no case for a picture -- it falls through to the default and is
        // passed to the device unvalidated, so a wrong number here fails with
        // no complaint from the SDK at all.
        type: 200,
        pageNum: page,
        layerNum: 0,
        picture: {
          picturePath: entry.image.path,
          rect: {
            left: MARGIN,
            top,
            right: MARGIN + drawnWidth,
            bottom: top + drawnHeight,
          },
        },
      });
      log(`digest: image ${entry.image.width}x${entry.image.height} placed at ${drawnWidth}x${drawnHeight}`);
    } else {
      log('digest: no room under the quote for the clipping, left as a file');
    }
  }

  try {
    const response = (await PluginFileAPI.insertElements(notePath, page, elements)) as
      | LooseResponse<boolean>
      | null
      | undefined;
    if (!response?.success) {
      const why = response?.error?.message ?? 'the device refused the digest';
      log(`digest: insertElements refused — ${why}`);
      return why;
    }
    log(`digest: wrote ${elements.length} element(s) to ${notePath} page ${page}`);
    return null;
  } catch (err) {
    const why = err instanceof Error ? err.message : 'an unknown error';
    log(`digest: insertElements threw — ${why}`);
    return why;
  }
}

/**
 * An empty page at the end of the digest note, creating the note if needed.
 *
 * A page of its own per entry rather than appending under the last one: the
 * device reports no text metrics, so where the previous excerpt actually ended
 * is unknowable, and guessing it wrong overlaps two quotes illegibly.
 *
 * Returns the page index, or a reason as a string.
 */
async function freshPage(notePath: string): Promise<number | string> {
  const total = await noteLength(notePath);
  const templates = await templateCandidates();

  if (total === null) {
    let last = 'the device refused to create it';
    for (const template of templates) {
      try {
        const created = (await PluginFileAPI.createNote({
          notePath,
          template,
          mode: 0,
          isPortrait: true,
        })) as LooseResponse<boolean> | null | undefined;
        // A false `result` with success true means it declined without saying
        // why, which is as much a failure as an error is.
        if (created?.success && created.result !== false) {
          log(`digest: created ${notePath} with template "${template}"`);
          // A new note already has one blank page; using it beats adding a second.
          return 0;
        }
        last = created?.error?.message ?? 'the device declined without saying why';
      } catch (err) {
        last = err instanceof Error ? err.message : 'an unknown error';
      }
      log(`digest: createNote rejected template "${template}" — ${last}`);
    }
    return `the lookup note could not be created (${last})`;
  }

  let last = 'the device refused the page';
  for (const template of templates) {
    try {
      const inserted = (await PluginFileAPI.insertNotePage({
        notePath,
        page: total,
        template,
      })) as LooseResponse<boolean> | null | undefined;
      if (inserted?.success && inserted.result !== false) {
        log(`digest: added page ${total} with template "${template}"`);
        return total;
      }
      last = inserted?.error?.message ?? 'the device declined without saying why';
    } catch (err) {
      last = err instanceof Error ? err.message : 'an unknown error';
    }
    log(`digest: insertNotePage rejected template "${template}" — ${last}`);
  }
  return `no page could be added to the lookup note (${last})`;
}

/**
 * Template strings to try, in order, when making a note or a page.
 *
 * Both calls insist on a non-empty template -- an empty string is rejected
 * outright with "template cannot be an empty string" -- and neither documents
 * what a valid one looks like. The built-in list is the only authority, and
 * whether the firmware wants a template's name or its URI is undocumented, so
 * both spellings of the first few go in and the first that works wins.
 */
async function templateCandidates(): Promise<string[]> {
  const candidates: string[] = [];
  try {
    const listed = await PluginCommAPI.getNoteSystemTemplates();
    // Unlike most of the SDK this resolves to a bare array, not an APIResponse.
    if (Array.isArray(listed)) {
      for (const entry of listed.slice(0, 4)) {
        const template = entry as {name?: string; vUri?: string};
        if (template?.name) {
          candidates.push(template.name);
        }
        if (template?.vUri) {
          candidates.push(template.vUri);
        }
      }
    }
  } catch (err) {
    log(`digest: could not list templates (${err instanceof Error ? err.message : String(err)})`);
  }
  if (candidates.length === 0) {
    // Nothing to go on. "none" is what the firmware calls a blank page in its
    // own template list, so it is the least unreasonable guess left.
    candidates.push('none', 'blank');
  }
  log(`digest: template candidates ${candidates.map(c => `"${c}"`).join(', ')}`);
  return candidates;
}

/** How many pages the note has, or null when there is no such note yet. */
async function noteLength(notePath: string): Promise<number | null> {
  try {
    const response = (await PluginFileAPI.getNoteTotalPageNum(notePath)) as
      | LooseResponse<number>
      | null
      | undefined;
    if (!response?.success || typeof response.result !== 'number') {
      return null;
    }
    return response.result;
  } catch {
    return null;
  }
}

/** The note page's own bounds, falling back to the common Supernote size. */
async function pageSize(
  notePath: string,
  page: number,
): Promise<{width: number; height: number}> {
  try {
    const response = (await PluginFileAPI.getPageSize(notePath, page)) as
      | LooseResponse<{width: number; height: number}>
      | null
      | undefined;
    if (response?.success && response.result?.width && response.result?.height) {
      return response.result;
    }
  } catch {
    // Falls through to the default below.
  }
  return {width: 1920, height: 2560};
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const LINK_HEIGHT = 52;
const LINK_FONT = 32;
const DIGEST_FONT = 40;
const MIN_IMAGE_HEIGHT = 200;
