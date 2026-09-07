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
  libraryUid?: string;
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
  const content = digest.content.trim();
  if (!content) {
    throw new Error('A digest needs some text.');
  }
  const payload: Record<string, unknown> = {
    content,
    uniqueIdentifier: `${Date.now().toString(16)}${Math.floor(Math.random() * 1e12).toString(16)}`,
    md5Hash: await native!.hash('MD5', content),
  };
  if (digest.sourcePath) {
    payload.sourcePath = digest.sourcePath;
    payload.sourceType = digest.sourceType ?? SOURCE_DOCUMENT;
  }
  if (typeof digest.page === 'number') {
    // A JSON string inside a JSON field, which is how the device stores it.
    payload.metadata = JSON.stringify({
      document_location_data: JSON.stringify([{page: digest.page}]),
    });
  }
  if (digest.libraryUid) {
    payload.parentUniqueIdentifier = digest.libraryUid;
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

    const keptPath = String(mine.sourcePath ?? '');
    const keptType = mine.sourceType;
    const metadata = String(mine.metadata ?? '');
    const survived =
      keptPath === bookPath
        ? 'the source path survived'
        : `the source path did NOT survive (got "${keptPath}")`;
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
