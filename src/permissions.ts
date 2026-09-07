/**
 * Network permission.
 *
 * INTERNET is gated at runtime for every outbound socket with no default-allowed
 * exception, so a WebView in a plugin loads nothing at all until the permission
 * is granted. The failure is invisible from JS — the socket is refused down in
 * native, so the page just never arrives and the panel looks broken rather than
 * blocked. Hence an explicit check before the first load.
 */

import {PluginManager} from 'sn-plugin-lib';

import {step} from './log';

/** Grant states returned by hasPermission/requestPermission. */
const GRANTED_THIS_SESSION = 1;
const GRANTED_ALWAYS = 2;

/**
 * Ensure the plugin may open network connections, prompting if it may not.
 *
 * "Allow this time only" is revoked when the plugin exits, so this asks the host
 * on every launch rather than remembering an earlier answer.
 */
export async function ensureNetwork(): Promise<boolean> {
  const existing = await step('hasPermission(INTERNET)', () =>
    PluginManager.hasPermission('plugin.permission.INTERNET'),
  );
  if (existing === GRANTED_THIS_SESSION || existing === GRANTED_ALWAYS) {
    return true;
  }

  // The description is only shown when the user has previously refused, which is
  // exactly when it is worth explaining that nothing is being sent anywhere —
  // the plugin only fetches the page being looked up.
  const choice = await step('requestPermission(INTERNET)', () =>
    PluginManager.requestPermission(
      'plugin.permission.INTERNET',
      'Look Up needs the network to fetch the page you are searching for.',
    ),
  );
  return choice === GRANTED_THIS_SESSION || choice === GRANTED_ALWAYS;
}

/**
 * Ensure the plugin may write to shared storage.
 *
 * Only the diagnostic log needs this. It is requested at startup rather than
 * lazily because a log that starts after the interesting part has happened is
 * no use — the whole point is to have the earliest steps on disk before
 * anything can go wrong.
 */
export async function ensureFileWrite(): Promise<boolean> {
  const existing = await step('hasPermission(FILE:WRITE)', () =>
    PluginManager.hasPermission('plugin.permission.FILE:WRITE'),
  );
  if (existing === GRANTED_THIS_SESSION || existing === GRANTED_ALWAYS) {
    return true;
  }
  const choice = await step('requestPermission(FILE:WRITE)', () =>
    PluginManager.requestPermission(
      'plugin.permission.FILE:WRITE',
      'Look Up writes a diagnostic log to Document/LookUp/log.txt.',
    ),
  );
  return choice === GRANTED_THIS_SESSION || choice === GRANTED_ALWAYS;
}

/** Shown when the answer is no, in place of the page. */
export const DENIED = 'Look Up needs network access to fetch a page.';
