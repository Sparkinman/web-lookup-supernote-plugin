/**
 * The native side of fetching and handing off.
 *
 * Both live in native code rather than JS: the fetch so that a failure is
 * caught and logged where the crash of a previous approach was not, and the
 * hand-off because opening another app needs an Intent.
 */

import {NativeModules} from 'react-native';

export interface Fetched {
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
}

interface WebNative {
  get(url: string): Promise<Fetched>;
  request(
    method: string,
    url: string,
    headersJson: string,
    body: string,
  ): Promise<{status: number; body: string}>;
  openExternally(url: string): Promise<boolean>;
}

const native: WebNative | undefined = NativeModules.LookUpWeb;

export const WEB_AVAILABLE = Boolean(native);

export function get(url: string): Promise<Fetched> {
  if (!native) {
    return Promise.reject(new Error('The fetch module did not load.'));
  }
  return native.get(url);
}

/**
 * Send a form back, for a search page whose next button is a post.
 *
 * DuckDuckGo's second page of results cannot be fetched with a GET -- an
 * offset in the query string returns the first page again -- so the form it
 * gave us goes back the way it came.
 */
export async function postForm(url: string, body: string): Promise<Fetched> {
  if (!native?.request) {
    throw new Error('The fetch module did not load.');
  }
  const answer = await native.request(
    'POST',
    url,
    JSON.stringify({
      'Content-Type': 'application/x-www-form-urlencoded',
      // The same text-browser agent the GET uses. A browser's agent gets a
      // bot-check page here instead of results.
      'User-Agent': 'Lynx/2.8.9rel.1 libwww-FM/2.14',
      'Accept-Language': 'en',
    }),
    body,
  );
  return {
    status: answer.status,
    finalUrl: url,
    contentType: 'text/html',
    body: answer.body,
  };
}

/** Hand a URL to the firmware's own viewer, which can render what this cannot. */
export function openExternally(url: string): Promise<boolean> {
  if (!native) {
    return Promise.reject(new Error('The viewer module did not load.'));
  }
  return native.openExternally(url);
}
