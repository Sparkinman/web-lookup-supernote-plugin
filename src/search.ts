/**
 * Where a query goes.
 *
 * The engine matters more than usual here. A normal search page on e-ink is a
 * bad experience: heavy JavaScript, wide layouts, and a full refresh for every
 * animation. These were measured rather than guessed — page weight and script
 * count for the query "e ink", fetched with a mobile user agent:
 *
 *   lite.duckduckgo.com    24 KB    0 scripts
 *   html.duckduckgo.com    14 KB    0 scripts   (answered 202, rate-limits bots)
 *   wiby.me                 5 KB    0 scripts
 *   mojeek.com              5 KB    4 scripts
 *   search.marginalia.nu   37 KB    4 scripts
 *   en.m.wikipedia.org    302 KB    7 scripts
 *
 * DuckDuckGo Lite is the pick for general search: mainstream result quality
 * with genuinely zero scripting. The plain duckduckgo.com would redirect to a
 * scripted page that scrolls badly and repaints constantly.
 */

export interface Lens {
  id: string;
  label: string;
  /** Build a URL for a query. */
  url(query: string): string;
  /** Shown under the search box so the behaviour is not a surprise. */
  hint: string;
}

const encode = (q: string) => encodeURIComponent(q.trim());

export const LENSES: Lens[] = [
  {
    id: 'quick',
    label: 'Quick',
    // !ducky is DuckDuckGo's "first result" bang: it skips the result list and
    // lands on the page itself. The redirect is driven by a small script rather
    // than an HTTP 3xx, so it needs JavaScript enabled in the WebView — which
    // it is. Worth knowing when debugging: fetching this URL with curl returns
    // a 573-byte redirect stub, not the destination.
    url: q => `https://duckduckgo.com/?q=${encode('!ducky ' + q)}`,
    hint: 'Opens the top result directly',
  },
  {
    id: 'web',
    label: 'Web',
    url: q => `https://lite.duckduckgo.com/lite/?q=${encode(q)}`,
    hint: 'Result list, no scripts',
  },
  {
    id: 'wikipedia',
    label: 'Wikipedia',
    // Special:Search resolves straight to the article when the query matches a
    // title, and shows results when it does not — so one URL covers both
    // "look up this term" and "find something about this".
    url: q => `https://en.m.wikipedia.org/wiki/Special:Search?search=${encode(q)}`,
    hint: 'Jumps to the article when the title matches',
  },
  {
    id: 'simple',
    label: 'Simple',
    // Wiby deliberately indexes small, hand-made, text-first pages. A niche
    // index, but the lightest thing on this list by a wide margin and the
    // closest the modern web gets to reading like a book.
    url: q => `https://wiby.me/?q=${encode(q)}`,
    hint: 'Lightweight, text-first pages only',
  },
];

/**
 * Quick is the default because of how this gets used: the query arrives from a
 * lasso around a specific term, and the thing wanted is the page about it, not
 * ten links to choose between. Web is one tap away when the guess is wrong.
 */
export const DEFAULT_LENS = LENSES[0];

export function lensById(id: string): Lens {
  return LENSES.find(l => l.id === id) ?? DEFAULT_LENS;
}

/**
 * Treat a query that is already a URL as one, so a lassoed link opens directly
 * instead of being searched for.
 */
export function isUrl(text: string): boolean {
  return /^(https?:\/\/|www\.)\S+$/i.test(text.trim());
}

export function resolve(query: string, lens: Lens): string {
  const trimmed = query.trim();
  if (!isUrl(trimmed)) {
    return lens.url(trimmed);
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
