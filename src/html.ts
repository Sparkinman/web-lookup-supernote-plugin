/**
 * Turning a fetched page into something readable on e-ink.
 *
 * A web page cannot be rendered here — PluginHost is a privileged process and
 * Android refuses to create a WebView in one — so the text is extracted and
 * drawn with ordinary React Native views instead. That constraint turns out to
 * suit the display: no scripts, no reflow, no repaint storms, and a column of
 * text at a fixed measure is what this screen is good at.
 */

import {log} from './log';
import {hostOf, queryParam, resolveUrl} from './url';

export {hostOf};

/** One readable unit. Blocks are what the reader shows and what it quotes. */
export interface Block {
  kind: 'heading' | 'paragraph' | 'result';
  text: string;
  /** Present on results and on paragraphs that are wholly a link. */
  href?: string;
  /** Result snippets, shown under the title. */
  detail?: string;
}

export interface Page {
  title: string;
  blocks: Block[];
  /**
   * The page a human should be shown, when that differs from what was fetched.
   *
   * Wikipedia is read through its API, and handing an api.php URL to the
   * device's browser would be a poor thing to do to someone who just wanted the
   * article.
   */
  viewerUrl?: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeChar(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);
}

function safeChar(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : '';
}

/** Strip tags from a fragment, leaving its text. */
export function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove the parts of a document that are never worth reading. */
function stripNoise(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

function titleOf(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? textOf(match[1]) : '';
}

/**
 * A line that is only an address.
 *
 * The fallback flattening turns a result list into paragraphs, and the bare
 * URLs among them read as text — indistinguishable from the snippet above
 * them, and impossible to tell apart when choosing what to keep. Recognising
 * them makes them followable, and lets the reader mark them as links.
 */
const BARE_URL = /^(https?:\/\/|www\.)[^\s]+$/i;

function asLink(text: string): Block | null {
  if (!BARE_URL.test(text)) {
    return null;
  }
  const href = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  return {kind: 'result', text, href};
}

/**
 * Generic extraction: headings and paragraphs, in document order.
 *
 * Deliberately simple. A full readability pass would guess at which container
 * holds the article, and guessing wrong drops the content entirely; taking every
 * heading and paragraph keeps some noise but never loses the substance.
 */
export function readArticle(html: string, baseUrl: string): Page {
  const clean = stripNoise(html);
  const blocks: Block[] = [];

  const pattern = /<(h[1-6]|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(clean)) !== null) {
    const tag = match[1].toLowerCase();
    const inner = match[2];
    const text = textOf(inner);
    // One-word fragments are navigation furniture far more often than prose.
    if (text.length < 2) {
      continue;
    }
    const href = soleLink(inner, baseUrl);
    if (href) {
      blocks.push({kind: tag.startsWith('h') ? 'heading' : 'paragraph', text, href});
      continue;
    }
    // A line that is only an address is a link even when the page did not mark
    // it as one — search engines that print their results as plain text are the
    // common case, and unmarked they are indistinguishable from prose.
    blocks.push(asLink(text) ?? {kind: tag.startsWith('h') ? 'heading' : 'paragraph', text});
  }

  return {title: titleOf(clean) || baseUrl, blocks: readable(dedupe(blocks))};
}

/**
 * Drop the navigation from a page that has prose as well.
 *
 * A site's menus, footers and related-article rails come through as short
 * blocks that are nothing but a link, and on a heavily built page they can
 * outnumber the article several times over -- which is how a page arrives here
 * as a list of links with no text in it.
 *
 * Only applied when there is enough prose to be confident which is which: on a
 * page that really is a list of links, throwing them away would leave nothing
 * at all. A long link is kept regardless, since a headline is a link too.
 */
function readable(blocks: Block[]): Block[] {
  const prose = blocks.filter(block => !block.href && block.text.length > 80);
  if (prose.length < 3) {
    return blocks;
  }
  const kept = blocks.filter(block => !block.href || block.text.length >= 40);
  return kept.length > 0 ? kept : blocks;
}

/** The href, when a block is entirely one link — so it can be followed. */
function soleLink(inner: string, baseUrl: string): string | undefined {
  const links = inner.match(/<a\b[^>]*>/gi);
  if (!links || links.length !== 1) {
    return undefined;
  }
  return absolute(hrefOf(links[0]), baseUrl);
}

function hrefOf(tag: string): string | undefined {
  const match = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  return match ? match[2] ?? match[3] ?? match[4] : undefined;
}

export function absolute(href: string | undefined, baseUrl: string): string | undefined {
  if (!href) {
    return undefined;
  }
  const value = decodeEntities(href).trim();
  if (!value || value.startsWith('#') || /^javascript:/i.test(value)) {
    return undefined;
  }
  // DuckDuckGo wraps outbound links; unwrap rather than following the redirect,
  // which costs a whole extra request on a slow connection.
  const resolved = resolveUrl(value, baseUrl);
  return resolved ? unwrapRedirect(resolved) : undefined;
}

function unwrapRedirect(url: string): string {
  const target = queryParam(url, 'uddg');
  return target || url;
}

/**
 * Drop repeats, keeping the first.
 *
 * Search pages in particular repeat a result's title in more than one element,
 * and the same line twice in a row reads as a rendering bug.
 */
function dedupe(blocks: Block[]): Block[] {
  const seen = new Set<string>();
  return blocks.filter(block => {
    const key = `${block.kind}:${block.text}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * DuckDuckGo Lite returns its results in a table, one result across several
 * rows: a numbered link, then a snippet. The generic article reader finds
 * nothing at all here — the page contains no headings and no paragraphs, only
 * table cells — so it is parsed on its own terms.
 *
 * Note the attribute quoting: this page writes `class='result-link'` with
 * single quotes, so any pattern that assumes double quotes silently matches
 * nothing and the reader comes up empty.
 */
export function readDuckDuckGoLite(html: string, baseUrl: string): Page {
  const clean = stripNoise(html);
  const blocks: Block[] = [];

  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const hits: {href: string; title: string; end: number}[] = [];
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(clean)) !== null) {
    if (!/result-link/i.test(match[1])) {
      continue;
    }
    const href = absolute(hrefOf(`<a ${match[1]}>`), baseUrl);
    const title = textOf(match[2]);
    if (href && title) {
      hits.push({href, title, end: anchor.lastIndex});
    }
  }

  hits.forEach((hit, index) => {
    // The snippet belongs to this result only if it appears before the next
    // one; a result with no abstract must not borrow the following result's.
    const limit = index + 1 < hits.length ? hits[index + 1].end : clean.length;
    const between = clean.slice(hit.end, limit);
    const snippet = /class=['"]?result-snippet['"]?[^>]*>([\s\S]*?)<\/td>/i.exec(between);
    blocks.push({
      kind: 'result',
      text: hit.title,
      href: hit.href,
      ...(snippet ? {detail: textOf(snippet[1])} : {}),
    });
  });

  if (blocks.length === 0) {
    return readArticle(html, baseUrl);
  }
  return {title: titleOf(clean) || 'Results', blocks};
}

/**
 * Wikipedia, read through its API rather than scraped.
 *
 * Special:Search redirects to the desktop site and returns some seventy
 * kilobytes of navigation wrapped around the text; the API returns the same
 * article as plain prose in a fraction of that, already free of markup.
 */
export function readWikipediaApi(body: string, baseUrl: string): Page {
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {title: 'Wikipedia', blocks: []};
  }

  const pages: any[] = parsed?.query?.pages ?? [];
  const blocks: Block[] = [];

  // Search results come back keyed by relevance in `index`, but the object
  // order does not preserve it.
  const ordered = [...pages].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0));

  for (const entry of ordered) {
    const title: string = entry?.title ?? '';
    const extract: string = (entry?.extract ?? '').trim();
    if (!title) {
      continue;
    }
    blocks.push({
      kind: 'heading',
      text: title,
      href: articleApiUrl(title),
    });
    for (const paragraph of extract.split(/\n{2,}/)) {
      const text = paragraph.replace(/\s+/g, ' ').trim();
      if (text.length > 1) {
        blocks.push({kind: 'paragraph', text});
      }
    }
  }

  const only = ordered.length === 1 ? ordered[0]?.title : undefined;
  return {
    title: only ?? 'Wikipedia',
    blocks,
    viewerUrl: only ? articleUrl(only) : searchUrl(baseUrl),
  };
}

/** The article as a person would read it, for the viewer hand-off. */
export function articleUrl(title: string): string {
  return `https://en.m.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

/**
 * The human search page matching an API request.
 *
 * Recovered from the request rather than passed in, so the parser stays a pure
 * function of what was fetched.
 */
function searchUrl(apiUrl: string): string {
  const term = queryParam(apiUrl, 'gsrsearch') || queryParam(apiUrl, 'titles');
  return `https://en.m.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(term)}`;
}

/** The API call that returns one article as plain text. */
export function articleApiUrl(title: string): string {
  const params = [
    'action=query',
    'format=json',
    'formatversion=2',
    'prop=extracts',
    'explaintext=1',
    'redirects=1',
    `titles=${encodeURIComponent(title)}`,
  ];
  return `https://en.wikipedia.org/w/api.php?${params.join('&')}`;
}

/** Pick the parser that suits the page. */
export function parse(body: string, url: string): Page {
  const page = choose(body, url);
  // Which parser ran, and what it found. A page that quietly falls back looks
  // identical to one that parsed badly, and the difference matters: the
  // fallback keeps the page's navigation furniture, which is what fills a
  // clipping with region pickers instead of results.
  log(`parse: ${page.blocks.length} blocks (${page.blocks[0]?.kind ?? 'none'}) from ${url}`);
  return page;
}

function choose(body: string, url: string): Page {
  const host = hostOf(url);
  if (/(^|\.)duckduckgo\.com$/i.test(host) && /\/lite/i.test(url)) {
    return withFallback(readDuckDuckGoLite(body, url), body, url);
  }
  if (/wikipedia\.org$/i.test(host) && url.includes('/w/api.php')) {
    return readWikipediaApi(body, url);
  }
  return withFallback(readArticle(body, url), body, url);
}

/**
 * Never show an empty reader.
 *
 * A parser that finds nothing is far more likely to have missed the page's
 * structure than to be looking at a page with no words on it. Flattening the
 * whole document is a poor read, but it is a read, and it beats a blank screen
 * that gives the user nothing to act on.
 */
function withFallback(page: Page, body: string, url: string): Page {
  if (page.blocks.length > 0) {
    return page;
  }
  // A sentinel rather than a newline: textOf collapses all whitespace, so
  // real newlines would not survive it to be split on.
  const BREAK = '\u0000';
  const flattened = textOf(
    stripNoise(body).replace(/<\/(p|div|tr|li|h[1-6])>/gi, BREAK),
  );
  const blocks: Block[] = flattened
    .split(BREAK)
    .map(part => part.trim())
    // Addresses are kept whatever their length; prose below a line or so is
    // navigation furniture rather than content.
    .filter(part => part.length > 40 || BARE_URL.test(part))
    .map(text => asLink(text) ?? {kind: 'paragraph' as const, text});
  return {...page, title: page.title || url, blocks};
}

