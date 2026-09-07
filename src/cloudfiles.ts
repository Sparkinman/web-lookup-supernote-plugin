/**
 * Supernote Cloud's file registry.
 *
 * A digest names its source document by a `source_size` and a 32-character
 * `unique_identifier`, not by path. The size is the file's byte count, but the
 * identifier is not any hash of the file this end can produce -- the whole
 * file's MD5 does not match it, and neither does any combination of that with
 * the path or the size. It is Supernote's own value for the file, and the file
 * registry is where it is kept: every row there carries an `md5` beside its
 * size.
 *
 * So it is looked up rather than computed. A different host from the digest
 * API, and one that refuses everything without a CSRF token it issues in a
 * response header.
 */

import {NativeModules} from 'react-native';

import {log} from './log';

interface WebNative {
  request(
    method: string,
    url: string,
    headersJson: string,
    body: string,
  ): Promise<{status: number; body: string; headers?: Record<string, string>}>;
}

const native: WebNative | undefined = NativeModules.LookUpWeb;

/** Not viewer.supernote.com: the file store lives on the other host. */
const BASE_URL = 'https://cloud.supernote.com/api';
const LIST = 'file/list/query';

let csrf = '';

async function ensureCsrf(): Promise<void> {
  if (csrf || !native) {
    return;
  }
  const response = await native.request('GET', `${BASE_URL}/csrf`, '{}', '');
  csrf = response.headers?.['x-xsrf-token'] ?? '';
  if (!csrf) {
    throw new Error('Supernote would not issue a CSRF token, so its file store cannot be read.');
  }
  log('cloudfiles: got a CSRF token');
}

async function post(token: string, path: string, payload: object): Promise<Record<string, unknown>> {
  if (!native) {
    throw new Error('This build has no network module.');
  }
  await ensureCsrf();
  const response = await native.request(
    'POST',
    `${BASE_URL}/${path}`,
    JSON.stringify({
      'Content-Type': 'application/json',
      'x-access-token': token,
      'X-XSRF-TOKEN': csrf,
    }),
    JSON.stringify(payload),
  );
  try {
    return JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    throw new Error(`Supernote's file store answered ${response.status} with something that was not JSON.`);
  }
}

export interface CloudFile {
  id: string;
  name: string;
  isFolder: boolean;
  size: number;
  md5: string;
}

/**
 * One folder's contents. "0" is the root.
 *
 * The sort arguments are not optional: without them the server answers
 * "Sorting condition cannot be empty", and it does so with a 200, which is easy
 * to mistake for an authentication problem.
 */
export async function listFolder(token: string, directoryId = '0'): Promise<CloudFile[]> {
  const out: CloudFile[] = [];
  let page = 1;
  while (true) {
    const body = await post(token, LIST, {
      directoryId: String(directoryId),
      pageNo: page,
      pageSize: 100,
      order: 'time',
      sequence: 'desc',
    });
    const rows = (body.userFileVOList as Record<string, unknown>[] | undefined) ?? [];
    for (const row of rows) {
      out.push({
        id: String(row.id ?? ''),
        name: String(row.fileName ?? '').trim(),
        isFolder: String(row.isFolder ?? '').toUpperCase() === 'Y',
        size: Number(row.size ?? 0),
        md5: String(row.md5 ?? ''),
      });
    }
    const pages = Number(body.pages ?? 1);
    if (page >= pages || rows.length === 0) {
      break;
    }
    page += 1;
  }
  return out.filter(entry => entry.id);
}

/**
 * Walk a path down from the root and answer with the file at the end of it.
 *
 * Takes the path as the cloud spells it -- "Document/Bible Stuff/Bible.pdf",
 * with no device mount point on the front.
 */
export async function findFile(token: string, cloudRelativePath: string): Promise<CloudFile | null> {
  const parts = cloudRelativePath.split('/').filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  let directoryId = '0';
  for (let i = 0; i < parts.length; i += 1) {
    const wanted = parts[i];
    const last = i === parts.length - 1;
    const entries = await listFolder(token, directoryId);
    const match = entries.find(entry => entry.name === wanted && entry.isFolder !== last);
    if (!match) {
      log(`cloudfiles: "${wanted}" is not in that folder (${entries.length} entries)`);
      return null;
    }
    if (last) {
      log(`cloudfiles: ${cloudRelativePath} -> id ${match.id}, size ${match.size}, md5 ${match.md5}`);
      return match;
    }
    directoryId = match.id;
  }
  return null;
}
