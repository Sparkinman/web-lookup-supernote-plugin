/**
 * URL handling that does not rely on the platform's `URL`.
 *
 * React Native's `URL` is a partial implementation. On the device `hostname`
 * comes back empty and relative resolution concatenates instead of resolving,
 * so `/topic/society` against an article URL produced
 * `…/story.php?title=x/topic/society` — a 404 every time. Because the same
 * broken `hostname` decided which parser to use, every search page also fell
 * back to flat text, which is why result lists arrived as numbered paragraphs
 * with bare addresses in them.
 *
 * None of that shows up off-device: Node's `URL` is complete, so the tests and
 * the local parser checks all passed.
 */

/** Scheme, host, port, path, query, fragment — as much as is needed here. */
const ABSOLUTE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The host of an absolute URL, lowercased, without userinfo or port. */
export function hostOf(url: string): string {
  const match = ABSOLUTE.exec(url.trim());
  if (!match) {
    return '';
  }
  const authority = match[2];
  const at = authority.lastIndexOf('@');
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
  return hostPort.replace(/:\d+$/, '').toLowerCase();
}

/**
 * Resolve `href` against `base`, the way a browser would.
 *
 * Covers the forms that actually appear in a page: already absolute,
 * protocol-relative, root-relative, query-only, fragment-only, and an ordinary
 * relative path. Anything it cannot make sense of comes back null rather than
 * as a plausible-looking wrong address.
 */
export function resolveUrl(href: string, base: string): string | null {
  const value = href.trim();
  if (!value) {
    return null;
  }
  if (HAS_SCHEME.test(value)) {
    return value;
  }

  const parts = ABSOLUTE.exec(base.trim());
  if (!parts) {
    return null;
  }
  const [, scheme, authority, path, query] = parts;
  const origin = `${scheme}://${authority}`;

  if (value.startsWith('//')) {
    return `${scheme}:${value}`;
  }
  if (value.startsWith('/')) {
    return origin + normalize(value);
  }
  if (value.startsWith('?')) {
    return origin + (path || '/') + value;
  }
  if (value.startsWith('#')) {
    return origin + (path || '/') + (query ?? '') + value;
  }

  // Relative to the base's directory, which is everything up to its last slash.
  const directory = (path || '/').replace(/[^/]*$/, '');
  return origin + normalize(directory + value);
}

/** Apply `.` and `..` segments, as a browser does before requesting. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '') {
      continue;
    }
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  const trailing = /(?:\/|\/\.|\/\.\.)$/.test(path) ? '/' : '';
  return `/${out.join('/')}${trailing}`;
}

/** One query parameter's decoded value, or '' when it is absent. */
export function queryParam(url: string, name: string): string {
  const match = new RegExp(`[?&]${name}=([^&#]*)`).exec(url);
  if (!match) {
    return '';
  }
  try {
    return decodeURIComponent(match[1].replace(/\+/g, ' '));
  } catch {
    return match[1];
  }
}
