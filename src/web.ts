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

/** Hand a URL to the firmware's own viewer, which can render what this cannot. */
export function openExternally(url: string): Promise<boolean> {
  if (!native) {
    return Promise.reject(new Error('The viewer module did not load.'));
  }
  return native.openExternally(url);
}
