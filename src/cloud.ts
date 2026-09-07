/**
 * Supernote Cloud, spoken to directly from the device.
 *
 * The device's own Digest is the only place these excerpts belong, and no SDK
 * call creates one -- the plugin can write digest-shaped elements into a note,
 * but a book's markup is unreachable from anywhere: locked (1206) while the
 * book is open, forbidden (102) once it is closed. The cloud is the remaining
 * door, and what is written through it syncs back down to the device.
 *
 * The protocol here is taken from a working implementation rather than guessed
 * at, which saves rediscovering two things that cost that author hours:
 *
 *   - Supernote calls digests "summaries" throughout the API.
 *   - The paging arguments on these endpoints are `page` and `size`, where the
 *     rest of the API uses `pageNo` and `pageSize`. Getting it wrong returns a
 *     bare "Server Error" with nothing to say which of a dozen causes it is.
 *
 * Nothing here goes through any server but Supernote's own.
 */

import {NativeModules} from 'react-native';

import {log} from './log';

interface WebNative {
  request(
    method: string,
    url: string,
    headersJson: string,
    body: string,
  ): Promise<{status: number; body: string}>;
  hash(algorithm: string, input: string): Promise<string>;
}

const native: WebNative | undefined = NativeModules.LookUpWeb;

export const CLOUD_AVAILABLE = Boolean(native?.request && native?.hash);

const BASE_URL = 'https://viewer.supernote.com/api';

/** Supernote's name for a digest, wherever it appears in a path. */
const QUERY_DIGESTS = 'file/query/summary';
const ADD_DIGEST = 'file/add/summary';
const DELETE_DIGEST = 'file/delete/summary';

/** Where a digest came from, in Supernote's numbering. */
export const SOURCE_DOCUMENT = 1;

/** Said when the session is no longer good, so callers can tell it apart. */
export const EXPIRED = 'Your Supernote sign-in has expired. Sign in again in Settings.';

export function isExpired(err: unknown): boolean {
  return err instanceof Error && err.message === EXPIRED;
}

/**
 * One request.
 *
 * `strict` decides what a `success: false` means. On the digest endpoints it is
 * a failure and worth throwing on. On the sign-in endpoints it is not: logging
 * in answers `success: false` with `errorCode` E1760 to say "this account wants
 * an emailed code", which is the normal path and not an error at all. Throwing
 * on it meant the code was never asked for, so no email was ever sent -- the
 * reference this was taken from checks the flag in its digest service and
 * deliberately does not in its sign-in.
 */
async function call(
  method: string,
  path: string,
  payload: object,
  token = '',
  strict = true,
): Promise<Record<string, unknown>> {
  if (!native) {
    throw new Error('This build has no network module.');
  }
  const headers: Record<string, string> = {'Content-Type': 'application/json'};
  if (token) {
    headers['x-access-token'] = token;
  }
  const response = await native.request(
    method,
    `${BASE_URL}/${path}`,
    JSON.stringify(headers),
    JSON.stringify(payload),
  );

  // A dead session is its own kind of failure and wants its own answer: the
  // token lasts thirty days and cannot be renewed, so this means "sign in
  // again" rather than "something went wrong".
  if (response.status === 401 || response.status === 403) {
    throw new Error(EXPIRED);
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Supernote answered ${response.status} with something that was not JSON.`,
    );
  }
  // Logged before it is judged. An earlier sign-in failed in a way nothing
  // recorded, and the reply was the only thing that would have said why.
  log(
    `cloud: ${path} -> ${response.status} ` +
      JSON.stringify(body, (key, value) =>
        key === 'token' && typeof value === 'string' ? `<${value.length} chars>` : value,
      ).slice(0, 700),
  );
  if (strict && body.success === false) {
    const message = String(body.errorMsg ?? `Supernote refused ${path}.`);
    throw new Error(
      message === 'Server Error, please try again later'
        ? 'Supernote refused the request without saying why, which usually means the arguments are wrong rather than that anything is down.'
        : message,
    );
  }
  return body;
}

/**
 * Step one of signing in: offer the password, then ask for the emailed code.
 *
 * The plain password never crosses the wire. The server hands out a nonce, the
 * password is MD5-hexed, the nonce appended, and that SHA-256-hexed -- which is
 * why signing in is more than one request.
 *
 * Asking for the code is three further calls, not a field on the login reply,
 * which is what an earlier version assumed and why no email ever arrived.
 * Logging in answers `errorCode` E1760 to mean "this account wants a code";
 * the endpoint that sends one is signed with a key the server hides inside a
 * token it hands out, where the token's last character is an index into its own
 * dash-separated parts and the part at that index is what gets hashed with the
 * address. None of that is guessable, and all of it is required.
 *
 * Resolves either a token, when the account needs no verification, or the two
 * values to hand back with the code.
 */
export async function beginSignIn(
  email: string,
  password: string,
): Promise<{token?: string; validCodeKey?: string; timestamp?: unknown}> {
  const account = email.trim();
  const challenge = await call(
    'POST',
    'official/user/query/random/code',
    {countryCode: '1', account},
    '',
    false,
  );
  const randomCode = String(challenge.randomCode ?? '');
  const timestamp = challenge.timestamp;
  if (!randomCode) {
    throw new Error(String(challenge.errorMsg ?? 'Supernote would not start a sign-in.'));
  }

  const md5 = await native!.hash('MD5', password);
  const digest = await native!.hash('SHA-256', md5 + randomCode);

  const result = await call(
    'POST',
    'official/user/account/login/new',
    {
      countryCode: 1,
      account,
      password: digest,
      browser: 'Chrome107',
      equipment: '1',
      loginMethod: '1',
      timestamp,
      language: 'en',
    },
    '',
    false,
  );

  const token = String(result.token ?? '');
  if (token) {
    log('cloud: signed in without a code');
    return {token};
  }
  if (result.errorCode !== 'E1760') {
    throw new Error(String(result.errorMsg ?? 'Supernote refused those details.'));
  }

  // A code is wanted, and asking for one is signed.
  const preAuth = await call('POST', 'user/validcode/pre-auth', {account}, '', false);
  const preToken = String(preAuth.token ?? '');
  const index = Number(preToken.slice(-1));
  const parts = preToken.split('-');
  const realKey = Number.isInteger(index) ? parts[index] : undefined;
  if (!preToken || realKey === undefined) {
    throw new Error(
      'Supernote returned a verification token in a shape this version does not recognise.',
    );
  }

  const sign = await native!.hash('SHA-256', `${account}${realKey}`);
  const sent = await call(
    'POST',
    'user/mail/validcode/send',
    {email: account, timestamp, token: preToken, sign},
    '',
    false,
  );
  const validCodeKey = String(sent.validCodeKey ?? '');
  if (!validCodeKey) {
    throw new Error(String(sent.errorMsg ?? 'Supernote would not send a verification code.'));
  }
  log('cloud: a code has been emailed');
  return {validCodeKey, timestamp};
}

/**
 * Step two: the code from the email.
 *
 * `email` rather than `account`, `equipment` 4 rather than 1, and the code
 * upper-cased -- these are not the same argument names the first step uses, and
 * the wrong ones are refused without saying which.
 */
export async function finishSignIn(
  email: string,
  code: string,
  validCodeKey: string,
  timestamp: unknown,
): Promise<string> {
  const result = await call(
    'POST',
    'official/user/sms/login',
    {
      email: email.trim(),
      validCode: code.trim().toUpperCase(),
      validCodeKey,
      timestamp,
      browser: 'Chrome107',
      equipment: '4',
    },
    '',
    false,
  );
  const token = String(result.token ?? '');
  if (!token) {
    throw new Error(
      String(
        result.errorMsg ??
          'That code was not accepted. They expire quickly, so ask for a new one if it has been more than a few minutes.',
      ),
    );
  }
  log('cloud: signed in with the emailed code');
  return token;
}

export interface NewDigest {
  content: string;
  /** The book it came from, so the device can offer the jump back. */
  sourcePath?: string;
  sourceType?: number;
  /** The page of that book, which Supernote keeps in a metadata blob. */
  page?: number;
  /**
   * The typed note on the passage -- the digest's "keyboard" section.
   *
   * A separate field from the passage itself, and the right home for where a
   * lookup came from: the content is what was read, the comment is what is
   * known about it.
   */
  comment?: string;
  /** Where the passage sits in that page's text, in characters. */
  startPosition?: number;
  endPosition?: number;
  /** The source document's byte count, which its digests record. */
  sourceSize?: number;
  libraryUid?: string;
}

/** A random lowercase hex string of the given length. */
function randomHex(length: number): string {
  let out = '';
  while (out.length < length) {
    out += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  }
  return out.slice(0, length);
}

/**
 * A path as the cloud stores it: relative to the device's storage root.
 *
 * A digest the device made names `Document/Bible Stuff/Bible.pdf`, where the
 * plugin knows the same file as `/storage/emulated/0/Document/...`. The prefix
 * is this device's mount point and means nothing to an account that may be read
 * on another one, so it is dropped.
 */
export function cloudPath(path: string): string {
  return path.replace(/^\/storage\/emulated\/\d+\//, '').replace(/^\/+/, '');
}

/**
 * One line, with runs of space collapsed.
 *
 * The device stores a passage lifted across a line break as a single line with
 * the break turned into spaces -- "wealth,     or gives to the rich" -- so a
 * digest written with real newlines in it is not shaped like the ones beside
 * it.
 */
function oneLine(text: string): string {
  return text.replace(/\s*\n+\s*/g, ' ').trim();
}

/**
 * Add a digest, and answer with its id.
 *
 * `uniqueIdentifier` is ours to choose and must not collide, so it is fresh
 * every time -- two identical passages are two digests, not one.
 *
 * The source fields are the open question. A digest read back from the account
 * carries `sourcePath`, `sourceType` and a `document_location_data` blob
 * holding the page, but whether they are accepted on creation or only ever set
 * by the device is undocumented, which is what the round trip below tests.
 */
export async function createDigest(token: string, digest: NewDigest): Promise<string> {
  const content = oneLine(digest.content);
  if (!content) {
    throw new Error('A digest needs some text.');
  }

  // Shaped after one the device made rather than after the minimum the API
  // accepts. The minimum is accepted and arrives inert: the jump back to the
  // book does not work and the passage does not show where the device's own
  // digests show theirs.
  const payload: Record<string, unknown> = {
    content,
    uniqueIdentifier: `${Date.now().toString(16)}${Math.floor(Math.random() * 1e12).toString(16)}`,
    md5Hash: await native!.hash('MD5', content),
    // Empty strings rather than absent. A real row carries "" for each of
    // these, and a null is not the same thing to whatever renders them.
    parentUniqueIdentifier: digest.libraryUid ?? '',
    // Not flattened. The passage above must be one line, because that is how
    // the device stores a quotation; the note is prose about it and reads as a
    // wall of text without its breaks.
    commentStr: (digest.comment ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(),
    commentHandwriteName: '',
    handwriteMD5: '',
    isSummaryGroup: 'N',
  };

  if (digest.sourcePath) {
    payload.sourcePath = cloudPath(digest.sourcePath);
    payload.sourceType = digest.sourceType ?? SOURCE_DOCUMENT;
  }

  if (typeof digest.page === 'number') {
    // A JSON string inside a JSON field, which is how the device stores it.
    // The positions are where the passage sits in the page's text; the size and
    // hash are how the file itself is identified, since the path alone is not
    // enough to find it on another device.
    const location: Record<string, number> = {chapter: 0, page: digest.page};
    if (typeof digest.startPosition === 'number') {
      location.startPosition = digest.startPosition;
    }
    if (typeof digest.endPosition === 'number') {
      location.endPosition = digest.endPosition;
    }
    const metadata: Record<string, unknown> = {
      document_location_data: JSON.stringify([location]),
    };
    if (digest.sourceSize) {
      metadata.source_size = digest.sourceSize;
    }
    // Fresh every time. Two digests taken from the same book carry different
    // values here -- 4c3263b9… and 6172d02a… for one Bible -- so this names the
    // digest, not the file, and is nothing to do with the file's hash. The
    // file's real MD5 does live in the cloud file registry, and is a third
    // number again.
    metadata.unique_identifier = randomHex(32);
    payload.metadata = JSON.stringify(metadata);
  }

  const body = await call('POST', ADD_DIGEST, payload, token);
  const id = String(body.id ?? '');
  if (!id) {
    throw new Error('Supernote accepted the digest but returned no id.');
  }
  return id;
}

/** One page of digests, newest first. `page` and `size`, not `pageNo`. */
export async function listDigests(token: string): Promise<Record<string, unknown>[]> {
  const body = await call('POST', QUERY_DIGESTS, {page: 1, size: 50}, token);
  for (const key of Object.keys(body)) {
    const value = body[key];
    if (Array.isArray(value)) {
      return value as Record<string, unknown>[];
    }
  }
  return [];
}

export async function deleteDigest(token: string, id: string): Promise<void> {
  await call('DELETE', DELETE_DIGEST, {id: Number(id)}, token);
}

/**
 * Create a digest carrying the source fields, read it back, then remove it.
 *
 * The point is the middle step: whether `sourcePath`, `sourceType` and the page
 * survive creation decides whether a digest made by this plugin can offer the
 * jump back into the book, or arrives as an orphan paragraph. Everything is
 * logged, and the digest is deleted afterwards so the account is left as it was
 * found.
 */
export async function testRoundTrip(
  token: string,
  bookPath: string,
  page: number,
): Promise<string> {
  const marker = `Web Lookup round-trip test ${new Date().toISOString()}`;
  let id = '';
  try {
    id = await createDigest(token, {
      content: marker,
      sourcePath: bookPath,
      sourceType: SOURCE_DOCUMENT,
      page,
    });
    log(`cloud: created digest ${id} claiming ${bookPath} page ${page}`);

    const rows = await listDigests(token);
    const mine = rows.find(row => String(row.id) === id);
    if (!mine) {
      log(`cloud: digest ${id} was not in the ${rows.length} rows read back`);
      return 'Created, but could not be read back.';
    }
    log(`cloud: READ BACK ${JSON.stringify(mine)}`);

    // One the device made itself, for comparison. Ours round-trips its fields,
    // but whether the tablet will actually offer the jump back may depend on
    // something only it sets -- fileId is null on ours and is the obvious
    // candidate. Field-for-field against a real one is how that gets settled.
    const theirs = rows.find(row => String(row.id) !== id && !String(row.content ?? '').startsWith('Web Lookup round-trip'));
    if (theirs) {
      log(`cloud: A REAL DIGEST FOR COMPARISON ${JSON.stringify(theirs)}`);
    } else {
      log('cloud: no digest made by the device to compare against');
    }

    const keptPath = String(mine.sourcePath ?? '');
    const sentPath = cloudPath(bookPath);
    const keptType = mine.sourceType;
    const metadata = String(mine.metadata ?? '');
    const survived =
      keptPath === sentPath
        ? 'the source path survived'
        : `the source path did NOT survive (sent "${sentPath}", got "${keptPath}")`;
    log(`cloud: ${survived}; sourceType=${String(keptType)}; metadata=${metadata}`);
    return `${survived}. Check the log for the whole row.`;
  } finally {
    if (id) {
      try {
        await deleteDigest(token, id);
        log(`cloud: removed the test digest ${id}`);
      } catch (err) {
        log(`cloud: could not remove test digest ${id} — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}


/**
 * Write a passage into the device's own Digest.
 *
 * The source fields are sent because they survive: a round trip confirmed that
 * `sourcePath`, `sourceType` and the page inside `document_location_data` all
 * come back exactly as they were sent, so a digest made here can name the book
 * and page it came from rather than arriving as an orphan paragraph.
 */
export async function addBookDigest(
  token: string,
  selection: string,
  found: string,
  bookPath: string,
  page: number,
  reference: string,
  urls: string[],
  identity: {md5: string; size: number} | null,
  positions: {start: number; end: number} | null,
): Promise<string> {
  // The book's own words are the digest -- they are what the entry is headed
  // with, and what it would be headed with had the device taken it. What the
  // web said about them is a note on that, which is what the typed section is
  // for. The other way round put a paragraph of search results where the
  // quotation belongs.
  // Laid out rather than run together: what was found, then where this was
  // looked up from, then the addresses, each on its own line. Joined with dashes
  // it was one long paragraph in which none of the three could be picked out.
  const note = [
    found.trim(),
    reference,
    urls.length > 0 ? urls.join('\n') : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return createDigest(token, {
    content: selection,
    comment: note,
    sourcePath: bookPath,
    sourceType: SOURCE_DOCUMENT,
    page,
    startPosition: positions?.start,
    endPosition: positions?.end,
    sourceSize: identity?.size,
  });
}


/**
 * Whether the stored session still works.
 *
 * One cheap authenticated read. A session lasts thirty days and cannot be
 * renewed, so it will lapse while nobody is looking -- and the first anyone
 * would otherwise know of it is a passage they meant to keep being refused.
 *
 * Answers true when the session is good, false when it has lapsed, and null
 * when the question could not be asked at all: a device with no network is not
 * a device that has been signed out, and treating it as one would throw away a
 * perfectly good token.
 */
export async function sessionIsGood(token: string): Promise<boolean | null> {
  if (!token) {
    return false;
  }
  try {
    await call('POST', QUERY_DIGESTS, {page: 1, size: 1}, token);
    log('cloud: the session is still good');
    return true;
  } catch (err) {
    if (isExpired(err)) {
      log('cloud: the session has expired');
      return false;
    }
    log(`cloud: could not check the session (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
}


/**
 * Work out how the device counts the positions in a digest.
 *
 * Our offsets are right for `getCurrentDocText`: asked for 175..500 the page
 * text really does read "And Judas said…" to "…so he will do." But the device
 * highlights ten characters later at the start and twenty later at the end, so
 * it counts against a shorter string than the one it hands out -- something in
 * the page, line breaks or the inline verse numbers, is not counted where we
 * count it. The drift grows with position, so there is no constant to subtract.
 *
 * A digest the device made is the answer key: it records the page, the exact
 * text, and where that text starts. Finding the same text in the same page and
 * comparing the two numbers gives the relationship outright rather than by
 * guesswork. Reads only.
 */
export async function calibrate(
  token: string,
  bookPath: string,
  readPage: (page: number) => Promise<string>,
): Promise<string> {
  const wanted = cloudPath(bookPath);
  const rows = await listDigests(token);

  const theirs: {page: number; content: string; start: number; end: number}[] = [];
  for (const row of rows) {
    if (String(row.sourcePath ?? '') !== wanted) {
      continue;
    }
    // Only the device's own. Ours were written with our own arithmetic and
    // would confirm nothing but itself.
    if (row.uniqueIdentifier) {
      continue;
    }
    try {
      const metadata = JSON.parse(String(row.metadata ?? '{}')) as Record<string, unknown>;
      const spots = JSON.parse(String(metadata.document_location_data ?? '[]')) as {
        page?: number;
        startPosition?: number;
        endPosition?: number;
      }[];
      const spot = spots[0];
      if (!spot || typeof spot.startPosition !== 'number' || typeof spot.page !== 'number') {
        continue;
      }
      theirs.push({
        page: spot.page,
        content: String(row.content ?? ''),
        start: spot.startPosition,
        end: spot.endPosition ?? spot.startPosition,
      });
    } catch {
      // A row whose metadata will not parse tells us nothing.
    }
  }

  if (theirs.length === 0) {
    log('calibrate: no digest the device made was found for this book');
    return 'No digest the device made was found for this book.';
  }

  const lines: string[] = [];
  for (const entry of theirs.slice(0, 4)) {
    // Any page of the open document can be read, not only the one on screen,
    // so nothing has to be navigated to for this.
    const pageText = await readPage(entry.page);
    if (!pageText) {
      log(`calibrate: page ${entry.page} gave no text`);
      continue;
    }
    const escaped = entry.content
      .trim()
      .split(/\s+/)
      .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+');
    const found = new RegExp(escaped).exec(pageText);
    if (!found) {
      log(
        `calibrate: page ${entry.page}, the device's own text is not in this page's text — ` +
          `device says ${entry.start}..${entry.end}, page is ${pageText.length} chars, ` +
          `content ${entry.content.length}`,
      );
      continue;
    }
    const ours = found.index;
    const oursEnd = ours + found[0].length;
    const before = pageText.slice(0, ours);
    // Counted so the shape of the difference is visible rather than inferred:
    // if it matches the newlines before the passage, or the digits, that is the
    // answer.
    const newlines = (before.match(/\n/g) ?? []).length;
    const digits = (before.match(/\d/g) ?? []).length;
    const spaces = (before.match(/[ \t]/g) ?? []).length;
    log(
      `calibrate: page ${entry.page} — device ${entry.start}..${entry.end}, ` +
        `ours ${ours}..${oursEnd}, difference ${entry.start - ours}..${entry.end - oursEnd}; ` +
        `before it: ${newlines} newlines, ${digits} digits, ${spaces} spaces, ` +
        `${before.length} chars; page ${pageText.length}, content ${entry.content.length}, ` +
        `device span ${entry.end - entry.start}`,
    );
    lines.push(`page ${entry.page}: device ${entry.start}, ours ${ours}`);
  }

  return lines.length > 0
    ? `${lines.join('; ')} — see the log.`
    : 'Found digests, but none of their text could be located in the pages.';
}
