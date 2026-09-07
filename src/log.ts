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
 * Whether anything is being written, decided at run time.
 *
 * A released build is silent, but a plugin that cannot be made to explain
 * itself on somebody else's device is a plugin whose bugs cannot be found:
 * there is no console on a Supernote and no way to attach one. So this is a
 * switch in Settings rather than a constant in the source, and turning it on
 * costs the user nothing until they need it.
 */
let writing = false;

const module_ = NativeModules.LookUpLog as LogStore | undefined;

/** Turn the log file on or off. Called from settings as they are loaded. */
export function setDiagnostics(on: boolean): void {
  writing = on && Boolean(module_);
}

const store = {
  get current(): LogStore | undefined {
    return writing ? module_ : undefined;
  },
};

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
  if (!writing) {
    return;
  }
  console.log(`[LookUp] ${line}`);
  store.current?.append(line)?.catch(() => {});
}

/**
 * Record a step and whatever it returned or threw.
 *
 * Wrapping the call rather than logging around it means the failing step names
 * itself; the last `->` line in the file is where execution stopped.
 */
export async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!writing) {
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
  store.current?.startSession(header)?.catch(() => {});
}

export function clearLog(): Promise<boolean> {
  return module_?.clear() ?? Promise.resolve(false);
}

export function logLocation(): Promise<string> {
  return module_?.location() ?? Promise.resolve('(native log module not loaded)');
}

/** Whether the native side is actually there — itself worth knowing. */
export const LOG_AVAILABLE = Boolean(module_);
