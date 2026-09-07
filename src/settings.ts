/**
 * What the plugin remembers between runs.
 *
 * Everything here is a choice with no right answer — what a capture should
 * leave behind, how a quotation from a book should be searched, what the link
 * under the handwriting ought to be called. Each depends on why the lookup is
 * happening, so each is the user's rather than ours.
 */

import {NativeModules} from 'react-native';

import {log} from './log';

interface SettingsNative {
  read(): Promise<string | null>;
  write(contents: string): Promise<string>;
  listDirs(relativePath: string): Promise<string[]>;
  makeDirs(relativePath: string): Promise<string>;
  fileInfo(path: string): Promise<{md5: string; size: number}>;
}

const native: SettingsNative | undefined = NativeModules.LookUpSettings;

/** What "Capture" puts in the note. */
export type CaptureMode = 'png' | 'link' | 'both';

/**
 * How a selection made inside a book becomes a query.
 *
 * A sentence lifted out of a book often means nothing on its own — a line of
 * scripture, a term of art, a character's name — and searching it alongside the
 * book's title is the difference between finding the passage and finding a
 * stranger's blog. But the same context ruins a lookup of a word that simply
 * needs defining, so it is a choice rather than a rule.
 */
export type BookQuery = 'text' | 'withBook';

/** Where excerpts taken from a book are collected. */
export const DEFAULT_DIGEST_NOTE = '/storage/emulated/0/Note/Look Up.note';

/**
 * One-tap words to add to a search.
 *
 * A passage searched verbatim returns the passage back, which is no use when
 * the thing wanted is an explanation of it. These are appended and the search
 * run again, so refining costs one tap rather than editing two hundred
 * characters on a stylus keyboard.
 *
 * Editable, because what is useful depends entirely on what is being read: a
 * scripture passage wants commentary, a datasheet wants a specification.
 */
export const DEFAULT_REFINEMENTS = [
  'explained',
  'meaning',
  'commentary',
  'summary',
  'history',
  'in context',
  'examples',
  'definition',
  'criticism',
  'how it works',
];

/** More than this and the row is taller than the thing it refines. */
export const MAX_REFINEMENTS = 10;

/**
 * Where drawn clippings and screenshots are written.
 *
 * Relative to shared storage, so it reads as a place on the device rather than
 * as an emulated-storage path. An absolute path is accepted too.
 */
export const DEFAULT_CLIP_FOLDER = 'Document/LookUp/clips';

export interface Settings {
  /** Whether a picture of what was read is drawn and linked. */
  savePicture: boolean;
  /** Whether the address of the page itself is linked beside it. */
  sourceLink: boolean;
  /** The lens last searched with, so the next lookup opens the way the last one ended. */
  lens: string;
  bookQuery: BookQuery;
  /** What the link to the saved clipping is called on the page. */
  notesLabel: string;
  /** The note that book excerpts are appended to, since a book cannot hold them. */
  digestNote: string;
  /** Where clippings and screenshots are saved. */
  clipFolder: string;
  /** The one-tap additions offered under the search box. */
  refinements: string[];
  /**
   * The last book a lookup was started from.
   *
   * Remembered so its markup can be examined later, from somewhere the file is
   * not locked. Not shown in settings: it is a note of where the user has been,
   * not a preference.
   */
  lastBook: string;
  /** Supernote Cloud account, for writing into the device's own Digest. */
  cloudEmail: string;
  /** The session token. Kept rather than the password, which is never stored. */
  cloudToken: string;
  /**
   * The half-finished sign-in, kept on disk rather than in memory.
   *
   * Reading the emailed code means leaving the device's plugin screen, which
   * closes the panel and takes any React state with it. Held here, the code
   * field is still waiting when the user comes back with the code.
   */
  cloudCodeKey: string;
  cloudCodeStamp: string;
}

export const DEFAULT_SETTINGS: Settings = {
  // Both on, because together they are the only combination that cannot lose
  // something: the picture keeps what was read, the link keeps where it came
  // from, and either alone throws away half of that.
  savePicture: true,
  sourceLink: true,
  lens: 'quick',
  // The selection alone: adding the book's title helps a quotation and hurts a
  // plain definition, and the plain definition is the commoner lookup.
  bookQuery: 'text',
  notesLabel: 'Notes',
  digestNote: DEFAULT_DIGEST_NOTE,
  clipFolder: DEFAULT_CLIP_FOLDER,
  refinements: DEFAULT_REFINEMENTS,
  lastBook: '',
  cloudEmail: '',
  cloudToken: '',
  cloudCodeKey: '',
  cloudCodeStamp: '',
};

/**
 * The two toggles as one mode, because that is what the drawing code wants.
 *
 * Kept as a derived value rather than as the stored shape: "picture, link, or
 * both" is a fine thing to hand a renderer and a poor thing to ask a person,
 * who is really answering two independent questions.
 */
export function captureMode(settings: Settings): CaptureMode | null {
  if (settings.savePicture && settings.sourceLink) {
    return 'both';
  }
  if (settings.savePicture) {
    return 'png';
  }
  if (settings.sourceLink) {
    return 'link';
  }
  // Neither: there is nothing to place, and pretending otherwise would leave an
  // orphaned drawing on disk pointed at by nothing.
  return null;
}

export const BOOK_QUERY_CHOICES: {value: BookQuery; label: string; hint: string}[] = [
  {
    value: 'text',
    label: 'The selection only',
    hint: 'Search exactly what you highlighted',
  },
  {
    value: 'withBook',
    label: 'With the book’s name',
    hint: 'Search the highlighted words in the context of what you are reading',
  },
];

/** Long enough to be descriptive, short enough to sit under the handwriting. */
export const MAX_LABEL_LENGTH = 24;

export async function loadSettings(): Promise<Settings> {
  if (!native) {
    return DEFAULT_SETTINGS;
  }
  try {
    const raw = await native.read();
    if (!raw) {
      return DEFAULT_SETTINGS;
    }
    const parsed = JSON.parse(raw) as Partial<Settings> & {capture?: unknown};
    // Merged over the defaults rather than used directly: a file written by an
    // older version is missing whatever has been added since.
    return {
      // Read through the old single-choice field when that is all the file has:
      // a settings file written by 2.0 predates the split into two toggles, and
      // silently resetting someone's choice is worse than a few lines here.
      savePicture:
        typeof parsed.savePicture === 'boolean'
          ? parsed.savePicture
          : isCaptureMode(parsed.capture)
          ? parsed.capture !== 'link'
          : DEFAULT_SETTINGS.savePicture,
      sourceLink:
        typeof parsed.sourceLink === 'boolean'
          ? parsed.sourceLink
          : isCaptureMode(parsed.capture)
          ? parsed.capture !== 'png'
          : DEFAULT_SETTINGS.sourceLink,
      lens: typeof parsed.lens === 'string' && parsed.lens ? parsed.lens : DEFAULT_SETTINGS.lens,
      bookQuery: isBookQuery(parsed.bookQuery) ? parsed.bookQuery : DEFAULT_SETTINGS.bookQuery,
      notesLabel: cleanLabel(parsed.notesLabel) ?? DEFAULT_SETTINGS.notesLabel,
      digestNote:
        typeof parsed.digestNote === 'string' && parsed.digestNote.trim()
          ? parsed.digestNote.trim()
          : DEFAULT_SETTINGS.digestNote,
      clipFolder:
        typeof parsed.clipFolder === 'string' && parsed.clipFolder.trim()
          ? parsed.clipFolder.trim()
          : DEFAULT_SETTINGS.clipFolder,
      refinements: Array.isArray(parsed.refinements)
        ? parsed.refinements
            .filter((word): word is string => typeof word === 'string')
            .map(word => word.replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .slice(0, MAX_REFINEMENTS)
        : DEFAULT_REFINEMENTS,
      lastBook: typeof parsed.lastBook === 'string' ? parsed.lastBook : '',
      cloudEmail: typeof parsed.cloudEmail === 'string' ? parsed.cloudEmail : '',
      cloudToken: typeof parsed.cloudToken === 'string' ? parsed.cloudToken : '',
      cloudCodeKey: typeof parsed.cloudCodeKey === 'string' ? parsed.cloudCodeKey : '',
      cloudCodeStamp: typeof parsed.cloudCodeStamp === 'string' ? parsed.cloudCodeStamp : '',
    };
  } catch (err) {
    log(`settings: could not read (${err instanceof Error ? err.message : String(err)})`);
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  if (!native) {
    return;
  }
  try {
    await native.write(JSON.stringify(settings, null, 2));
  } catch (err) {
    log(`settings: could not save (${err instanceof Error ? err.message : String(err)})`);
  }
}

/**
 * A file's size and content hash, or null when it cannot be read.
 *
 * Supernote identifies a source document by this pair rather than by its path:
 * a digest the device made carries `source_size` and a 32-hex
 * `unique_identifier` beside the page reference.
 */
export async function fileInfo(
  path: string,
): Promise<{md5: string; size: number} | null> {
  if (!native?.fileInfo || !path) {
    return null;
  }
  try {
    return await native.fileInfo(path);
  } catch (err) {
    log(`fileInfo failed (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
}

/**
 * The immediate subfolders of a path, for the folder picker.
 *
 * Resolves to nothing rather than throwing: a browser that shows an empty
 * folder is usable, one that crashes the settings screen is not.
 */
export async function listDirs(relativePath: string): Promise<string[]> {
  if (!native?.listDirs) {
    return [];
  }
  try {
    return await native.listDirs(relativePath);
  } catch (err) {
    log(`settings: listDirs failed (${err instanceof Error ? err.message : String(err)})`);
    return [];
  }
}

/**
 * A label the device can actually draw.
 *
 * An empty one would place an invisible link — present on the page, impossible
 * to find — so it falls back rather than being written as given.
 */
function cleanLabel(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_LENGTH);
  return trimmed ? trimmed : null;
}

export function labelOr(value: string, fallback: string): string {
  return cleanLabel(value) ?? fallback;
}

function isCaptureMode(value: unknown): value is CaptureMode {
  return value === 'png' || value === 'link' || value === 'both';
}

function isBookQuery(value: unknown): value is BookQuery {
  return value === 'text' || value === 'withBook';
}
