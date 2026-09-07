/**
 * Reading a note page, and nothing else.
 *
 * Round A of getting tap-to-expand right. It writes nothing at all: no
 * elements, no deletions, and above all no `saveCurrentNote`, which is what
 * destroyed a page last time -- called after an element write it pushes the
 * plugin's stale cached copy of the page back over the real file, taking
 * everything that was on it.
 *
 * Two things are being established here, both of which were assumed before and
 * neither of which had been seen:
 *
 *   1. What `getElements` actually returns for a page with handwriting on it --
 *      the types, the `numInPage` values a deletion would later depend on, and
 *      whether anything already carries a `userData`.
 *   2. Whether a finger tap's coordinates are in the same space as an element's
 *      rectangle. Collapse/Expand compares them directly in portrait, which
 *      suggests they are, but suggests is not knows.
 */

import {PluginCommAPI, PluginFileAPI} from 'sn-plugin-lib';

import {log} from './log';

interface LooseResponse<T> {
  success?: boolean;
  result?: T | null;
  error?: {message?: string} | null;
}

function unwrap<T>(res: unknown): T | null {
  const parsed = res as LooseResponse<T> | null | undefined;
  return parsed?.success && parsed.result != null ? parsed.result : null;
}

/** What sort of thing an element is, in words rather than a number. */
function describe(type: number): string {
  switch (type) {
    case 0:
      return 'stroke';
    case 100:
      return 'title';
    case 200:
      return 'picture';
    case 500:
      return 'text';
    case 501:
      return 'digest-quote';
    case 502:
      return 'digest-made';
    case 600:
      return 'link';
    case 700:
      return 'geometry';
    case 800:
      return 'five-star';
    default:
      return `type-${type}`;
  }
}

function rectOf(element: Record<string, unknown>): string {
  const box = element.textBox as {textRect?: Record<string, number>} | undefined;
  const link = element.link as Record<string, number> | undefined;
  const picture = element.picture as {rect?: Record<string, number>} | undefined;
  if (box?.textRect) {
    const r = box.textRect;
    return `text ${r.left},${r.top}..${r.right},${r.bottom}`;
  }
  if (link) {
    return `link ${link.X},${link.Y} ${link.width}x${link.height}`;
  }
  if (picture?.rect) {
    const r = picture.rect;
    return `picture ${r.left},${r.top}..${r.right},${r.bottom}`;
  }
  const maxX = element.maxX;
  const maxY = element.maxY;
  return typeof maxX === 'number' ? `maxX=${maxX} maxY=${maxY}` : 'no rectangle reported';
}

/** Everything on the page the plugin was opened over. Read only. */
export async function dumpPage(): Promise<void> {
  const path = unwrap<string>(await PluginCommAPI.getCurrentFilePath());
  const page = unwrap<number>(await PluginCommAPI.getCurrentPageNum());
  if (!path || typeof page !== 'number') {
    log('probe: nothing open to read');
    return;
  }
  if (!/\.note$/i.test(path)) {
    log(`probe: ${path} is not a note, leaving it alone`);
    return;
  }

  const response = (await PluginFileAPI.getElements(page, path)) as
    | LooseResponse<Record<string, unknown>[]>
    | null
    | undefined;
  if (!response?.success || !Array.isArray(response.result)) {
    log(`probe: could not read page ${page} — ${JSON.stringify(response?.error ?? null)}`);
    return;
  }

  const elements = response.result;
  log(`probe: ${path} page ${page} holds ${elements.length} element(s)`);
  elements.forEach((element, index) => {
    const type = Number(element.type);
    const userData = typeof element.userData === 'string' ? element.userData : '';
    const box = element.textBox as {textContentFull?: string} | undefined;
    const words = (box?.textContentFull ?? '').replace(/\s+/g, ' ').slice(0, 60);
    log(
      `probe:   [${index}] ${describe(type)} numInPage=${String(element.numInPage)} ` +
        `layer=${String(element.layerNum)} ${rectOf(element)}` +
        (words ? ` text="${words}"` : '') +
        // Printed even when empty: its absence is the thing worth seeing.
        ` userData=${userData ? `${userData.length}:"${userData.slice(0, 40)}"` : 'none'}`,
    );
  });

  const size = unwrap<{width: number; height: number}>(await PluginFileAPI.getPageSize(path, page));
  log(`probe: page size ${size?.width ?? '?'}x${size?.height ?? '?'}`);
}

/**
 * Report where a finger tap landed, and what it landed on. Read only.
 *
 * The point of this is the last line: if the rectangles printed here contain
 * the tap when the finger was over them, then motion coordinates and element
 * rectangles share a space and a hit test is arithmetic. If they do not, the
 * difference between them is the conversion still needed.
 */
export async function reportTap(x: number, y: number): Promise<void> {
  const path = unwrap<string>(await PluginCommAPI.getCurrentFilePath());
  const page = unwrap<number>(await PluginCommAPI.getCurrentPageNum());
  if (!path || typeof page !== 'number' || !/\.note$/i.test(path)) {
    return;
  }
  const elements =
    unwrap<Record<string, unknown>[]>(await PluginFileAPI.getElements(page, path)) ?? [];

  const hits: string[] = [];
  for (const element of elements) {
    const box = element.textBox as {textRect?: Record<string, number>} | undefined;
    const r = box?.textRect;
    if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      hits.push(`${describe(Number(element.type))}#${String(element.numInPage)}`);
    }
  }
  log(
    `probe: finger tap at ${Math.round(x)},${Math.round(y)} on page ${page} — ` +
      (hits.length > 0 ? `inside ${hits.join(', ')}` : 'inside nothing with a rectangle'),
  );
}
