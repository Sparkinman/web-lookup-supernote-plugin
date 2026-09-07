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
  /**
   * The same query, further down the list.
   *
   * Absent when there is no more to fetch, which is how the reader knows
   * whether to offer another page at all.
   */
  more?(query: string, offset: number): string;
  /** Shown under the search box so the behaviour is not a surprise. */
  hint: string;
  /**
   * Open the first result instead of showing the list.
   *
   * Replaces DuckDuckGo's `!ducky` bang, which cannot work here: that redirect
   * is performed by a script on the page, and this reader fetches HTML rather
   * than running it. Following the first link of a fetched result list reaches
   * the same place without needing a browser.
   */
  followFirst?: boolean;
}

const encode = (q: string) => encodeURIComponent(q.trim());

export const LENSES: Lens[] = [
  {
    id: 'quick',
    label: 'Top hit',
    url: q => `https://lite.duckduckgo.com/lite/?q=${encode(q)}`,
    hint: 'DuckDuckGo, opened straight into the best match',
    followFirst: true,
  },
  {
    id: 'web',
    label: 'DuckDuckGo',
    url: q => `https://lite.duckduckgo.com/lite/?q=${encode(q)}`,
    // `s` is the offset into the results. The lite page's own next-page control
    // is a form post carrying half a dozen hidden fields, but the offset alone
    // is enough to get the following ten.
    more: (q, offset) => `https://lite.duckduckgo.com/lite/?q=${encode(q)}&s=${offset}`,
    hint: 'The whole result list from DuckDuckGo, ten at a time',
  },
  {
    id: 'wikipedia',
    label: 'Wikipedia',
    // Read through the API rather than the site. Special:Search redirects to
    // the desktop layout and returns some seventy kilobytes of navigation
    // wrapped around the prose; this returns the same articles as plain text,
    // already free of markup, and covers both "look up this term" and "find
    // something about this" in one request.
    url: q =>
      'https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2' +
      `&generator=search&gsrsearch=${encode(q)}&gsrlimit=8` +
      '&prop=extracts&exintro=1&explaintext=1',
    more: (q, offset) =>
      'https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2' +
      `&generator=search&gsrsearch=${encode(q)}&gsrlimit=8&gsroffset=${offset}` +
      '&prop=extracts&exintro=1&explaintext=1',
    hint: 'Encyclopedia articles only, as plain prose',
  },
  {
    id: 'simple',
    label: 'Wiby',
    // Wiby deliberately indexes small, hand-made, text-first pages. A niche
    // index, but the lightest thing on this list by a wide margin and the
    // closest the modern web gets to reading like a book.
    url: q => `https://wiby.me/?q=${encode(q)}`,
    more: (q, offset) => `https://wiby.me/?q=${encode(q)}&p=${Math.floor(offset / 10) + 2}`,
    hint: 'Small hand-made pages, no advertising or scripts',
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
