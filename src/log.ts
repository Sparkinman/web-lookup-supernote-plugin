/**
 * Diagnostics, off in a released build.
 *
 * While this plugin was being built, every step wrote a line to
 * Document/LookUp/log.txt so a failure on the device could be read afterwards
 * -- there is no console on a Supernote, and a crash tears the plugin view
 * down before anything on screen can be read. That file has no place in
 * somebody else's Document folder, so a release writes nothing at all.
 *
 * The call sites are left in place and cost a comparison each. Turning
 * `DIAGNOSTICS` back on and rebuilding restores the whole trace, which is far
 * easier than putting the instrumentation back when something needs
 * diagnosing.
 */

import {NativeModules} from 'react-native';

interface LogStore {
  append(line: string): Promise<string>;
  startSession(header: string): Promise<string>;
  clear(): Promise<boolean>;
  location(): Promise<string>;
}

/**
 * Set true, and rebuild, to write Document/LookUp/log.txt while diagnosing.
 *
 * A constant rather than a setting: a released plugin should not offer a
 * control that exists only for whoever wrote it, and a log file has no
 * business appearing in somebody else's Document folder.
 */
const DIAGNOSTICS = false;

const store: LogStore | undefined = DIAGNOSTICS
  ? (NativeModules.LookUpLog as LogStore | undefined)
  : undefined;

/**
 * Write one line.
 *
 * Deliberately not awaited by callers: the whole point is to record what
 * happened immediately before something died, so a logging round trip must
 * never sit between the call and the thing being diagnosed. A failure to write
 * the log is swallowed — a diagnostic that can itself crash the run is worse
 * than no diagnostic.
 */
export function log(line: string): void {
  if (!DIAGNOSTICS) {
    return;
  }
  console.log(`[LookUp] ${line}`);
  store?.append(line)?.catch(() => {});
}

/**
 * Record a step and whatever it returned or threw.
 *
 * Wrapping the call rather than logging around it means the failing step names
 * itself; the last `->` line in the file is where execution stopped.
 */
export async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!DIAGNOSTICS) {
    return fn();
  }
  log(`-> ${name}`);
  try {
    const value = await fn();
    log(`<- ${name} ok: ${describe(value)}`);
    return value;
  } catch (err) {
    log(`!! ${name} threw: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

/** Short, safe rendering of a value for the log. */
function describe(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === 'string') {
    return value.length > 120 ? `${value.slice(0, 120)}…` : value;
  }
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      return json.length > 200 ? `${json.slice(0, 200)}…` : json;
    } catch {
      return '[unserialisable object]';
    }
  }
  return String(value);
}

export function startSession(header: string): void {
  store?.startSession(header)?.catch(() => {});
}

export function clearLog(): Promise<boolean> {
  return store?.clear() ?? Promise.resolve(false);
}

export function logLocation(): Promise<string> {
  return store?.location() ?? Promise.resolve('(native log module not loaded)');
}

/** Whether the native side is actually there — itself worth knowing. */
export const LOG_AVAILABLE = Boolean(store);
