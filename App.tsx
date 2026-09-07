/**
 * Look Up — a reader over a note.
 *
 * Opened by lassoing handwriting in NOTE, selecting text in DOC, or from the
 * toolbar. The selection becomes a query, the result is fetched and shown as
 * text, and any passage of it can be written back into the note — which is the
 * whole point of doing this on the device rather than reaching for a phone.
 *
 * There is no browser here and cannot be one: PluginHost is a privileged
 * process and Android refuses to create a WebView in one. Pages are fetched and
 * their text rendered with ordinary React Native views. Anything that genuinely
 * needs a browser is handed to the firmware's viewer instead.
 */

import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  BackHandler,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  findNodeHandle,
} from 'react-native';
import {PluginManager} from 'sn-plugin-lib';

import {
  captureAnchor,
  pageText,
  positionInPage,
  readDocSelectionAsQuery,
  readLassoAsQuery,
  reference,
  withBookContext,
  type Anchor,
} from './src/capture';
import {
  attachClip,
  attachScreenshot,
  CLIP_AVAILABLE,
  insertPassages,
  type ClipSection,
} from './src/clip';
import {hostOf, parse, type Block, type Page} from './src/html';
import {asAddress} from './src/url';
import {log, LOG_AVAILABLE} from './src/log';
import {DENIED, ensureFileWrite, ensureNetwork} from './src/permissions';
import {DEFAULT_LENS, LENSES, lensById, resolve, type Lens} from './src/search';
import {
  captureMode,
  DEFAULT_SETTINGS,
  fileInfo,
  labelOr,
  loadSettings,
  saveSettings,
  type Settings,
} from './src/settings';
import {addBookDigest, calibrate, isExpired, sessionIsGood} from './src/cloud';
import {SettingsScreen} from './src/Settings';
import {get, openExternally, postForm, WEB_AVAILABLE} from './src/web';
import {
  onButtonPress,
  onConfigPress,
  takePendingButton,
  takePendingConfig,
} from './index';

/** How long the confirmation stays up before the panel closes, in milliseconds. */
const CLOSE_DELAY = 700;

/**
 * How many passages a clipping takes when none were chosen.
 *
 * "Insert links" with nothing picked means "keep this page", and a page can run
 * to a thousand paragraphs. Beyond this the drawing is unreadable, slow to
 * make, and too tall for the image viewer to open.
 */
const MAX_UNPICKED = 25;

/** Button ids, matching index.js. */
const TOOLBAR_BUTTON = 100;
const DOC_SELECTION_BUTTON = 300;

export default function App(): React.JSX.Element {
  const [query, setQuery] = useState('');
  /**
   * What was actually selected in the book, before the box was touched.
   *
   * The digest is headed with this rather than with the search box: the box may
   * have been edited, may carry the book's title as context, and is a search
   * rather than a quotation.
   */
  const [selection, setSelection] = useState('');
  const [lens, setLens] = useState<Lens>(DEFAULT_LENS);
  const [page, setPage] = useState<Page | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  /** Which page of results is showing, counting from one. */
  const [resultPage, setResultPage] = useState(1);
  /**
   * Whether to draw only the prose of the page being read.
   *
   * Off to begin with, and reset by every new search: the links are the point
   * of a result list. Once inside an article they are mostly the site's own
   * furniture, and hiding them is the difference between reading a page and
   * hunting through it.
   */
  const [hideLinks, setHideLinks] = useState(false);
  /**
   * Reading the page as one piece of text, so it can be selected.
   *
   * React Native reports a selection in a text field and nowhere else, which is
   * why passages are otherwise chosen by tapping. In this mode the page becomes
   * a single field, the device's own handles work, and what they enclose is
   * what gets captured -- at the cost of the arrows, since there are no
   * separate blocks left to hang them on.
   */
  const [selecting, setSelecting] = useState(false);
  const [range, setRange] = useState({start: 0, end: 0});
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<number[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  /**
   * Where this lookup started, read while the lasso was still live.
   *
   * Held rather than re-read: attaching happens after the reader has been
   * browsed, by which time there is no lasso left to ask.
   */
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The note as it will be saved, open to being edited first.
   *
   * Tapping chooses whole passages, which is the right size for a stylus and
   * the wrong size for a quotation -- a paragraph is kept to get at one
   * sentence of it. Rather than build a text selection the platform cannot read
   * back, what was chosen is offered as text and can be cut down before it goes
   * anywhere.
   */
  const [note, setNote] = useState('');
  const [editingNote, setEditingNote] = useState(false);
  /** Whether the draft has been touched, so choosing again does not overwrite it. */
  const noteTouched = useRef(false);
  /**
   * Work that has been done and not yet kept anywhere.
   *
   * Only edits count. Choosing passages is undone by choosing them again, but
   * a paragraph somebody has cut down by hand exists nowhere else, and closing
   * the panel is the one action here that cannot be taken back.
   */
  const [unsaved, setUnsaved] = useState(false);
  /** A question that must be answered before the thing behind it happens. */
  const [confirm, setConfirm] = useState<{question: string; act: () => void} | null>(null);
  /** The same flag for callbacks registered once, which never see it change. */
  const unsavedRef = useRef(false);
  /** The highlight drift is measured once a run; it does not change. */
  const calibrated = useRef(false);
  /**
   * Where each passage sits in the list, and what part of the list is shown.
   *
   * React Native will not say which children are visible, but each one reports
   * its own position when it is laid out and the list reports how far it has
   * been scrolled and how tall it is, which is the same answer by arithmetic.
   */
  const blockAt = useRef<Map<number, {y: number; height: number}>>(new Map());
  const viewport = useRef({scrollY: 0, height: 0});
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  /** The part of the panel a screenshot photographs: the reader, not the chrome. */
  const readerRef = useRef<View>(null);
  /**
   * The scrolling list of passages.
   *
   * Held so it can be sent back to the top when the page underneath it
   * changes. Without that, following a link from halfway down a result list
   * leaves the scroll exactly where it was: the new page has loaded, but what
   * is on screen is a hundred lines into it, or past its end entirely if it is
   * shorter than the last one. It reads as the link having failed.
   */
  const scrollRef = useRef<ScrollView>(null);
  /**
   * The lens a button-started lookup should use.
   *
   * A ref rather than the `lens` state because the lookup is kicked off from
   * callbacks that were created before the state settled -- the mount effect
   * loads the setting and searches in the same pass, and a later button press
   * runs through a listener registered once. Reading state there gave whatever
   * the first render had, which is how choosing Web and then lassoing something
   * still came back as Quick.
   */
  const lensRef = useRef<Lens>(DEFAULT_LENS);
  /** Settings, likewise, for the callbacks that run before state has caught up. */
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);
  /**
   * A stable handle on `change`, for the same reason.
   *
   * startFromButton is registered once as a button listener; depending on
   * `change` directly would rebuild it on every settings write and re-register
   * the listener with it.
   */
  const changeRef = useRef<(patch: Partial<Settings>) => void>(() => {});

  /** Change lens everywhere at once: on screen, for the next lookup, and on disk. */
  const chooseLens = useCallback((next: Lens) => {
    lensRef.current = next;
    setLens(next);
    setSettings(prev => {
      const updated = {...prev, lens: next.id};
      settingsRef.current = updated;
      saveSettings(updated);
      return updated;
    });
  }, []);

  /** Change a setting everywhere at once. */
  const change = useCallback((patch: Partial<Settings>) => {
    setSettings(prev => {
      const updated = {...prev, ...patch};
      settingsRef.current = updated;
      saveSettings(updated);
      return updated;
    });
  }, []);
  changeRef.current = change;

  /**
   * Fetch a URL and show it.
   *
   * `follow` is how the Quick lens works: fetch the result list, then go
   * straight to the first result rather than showing it. It is a parameter
   * rather than read from the lens so that following a link from a result list
   * never triggers another hop.
   */
  const open = useCallback(async (target: string, follow = false) => {
    setLoading(true);
    setStatus(null);
    setPicked([]);
    try {
      if (!(await ensureNetwork())) {
        setStatus(DENIED);
        return;
      }
      const response = await get(target);
      if (response.status >= 400) {
        setStatus(`That page returned ${response.status}.`);
        return;
      }
      const parsed = parse(response.body, response.finalUrl);

      const first = follow ? parsed.blocks.find(b => b.href)?.href : undefined;
      if (first) {
        log(`following first result: ${first}`);
        setHistory(prev => [...prev, response.finalUrl]);
        await open(first);
        return;
      }

      setUrl(response.finalUrl);
      setPage(parsed);
      // Before anything is drawn, so the page is never briefly shown from the
      // middle. `animated: false` because this is e-ink: a smooth scroll is a
      // sequence of full-screen repaints.
      scrollRef.current?.scrollTo({y: 0, animated: false});
      // The old measurements describe a page that is no longer there.
      blockAt.current.clear();
      viewport.current.scrollY = 0;
      if (parsed.blocks.length === 0) {
        setStatus('Nothing readable on that page. Try opening it in the viewer.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`open failed: ${message}`);
      setStatus(`Could not fetch that: ${message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const search = useCallback(
    async (text: string, withLens: Lens) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      // An address goes where it says rather than being searched for. The box
      // takes both because a second box, empty almost always, is worse.
      const address = asAddress(trimmed);
      if (address) {
        log(`address: ${address}`);
        setHistory([]);
        setResultPage(1);
        await open(address);
        return;
      }
      log(`search: "${trimmed}" lens=${withLens.id}`);
      setHistory([]);
      setResultPage(1);
      setHideLinks(false);
      setSelecting(false);
      await open(resolve(trimmed, withLens), withLens.followFirst);
    },
    [open],
  );

  /**
   * Begin a lookup for whichever button was pressed.
   *
   * Shared between mounting and later presses. The panel is mounted once, so a
   * second lasso arrives as an event rather than a remount — without handling
   * it here the first lookup's results would just sit there.
   */
  const startFromButton = useCallback(
    async (buttonId: number | null) => {
      log(`start: button=${buttonId}`);

      // Cleared before anything else, and for every way in. The panel is
      // mounted once and shown again rather than rebuilt, so whatever was on it
      // last -- a settings screen, the previous search -- is still there when
      // it reappears, and reads as the press having done nothing.
      setShowSettings(false);
      setPage(null);
      // The box too. A passage from the last lookup left in it is a long thing
      // to delete by hand before typing something else.
      setQuery('');
      setSelection('');
      setUrl(null);
      setHistory([]);
      setPicked([]);
      setAnchor(null);
      setStatus(null);
      setNote('');
      setEditingNote(false);
      noteTouched.current = false;

      if (buttonId === TOOLBAR_BUTTON) {
        log('toolbar entry, no capture');
        return;
      }

      let capturedAnchor: Anchor | null = null;
      try {
        // Before recognition, and for documents as well as notes: reading the
        // lasso is part of what the anchor describes, and anything that
        // disturbs the selection would lose it. A book cannot be written into,
        // but it still names where the lookup came from -- and, when asked for,
        // lends its title to the search.
        try {
          const captured = await captureAnchor();
          capturedAnchor = captured;
          setAnchor(captured);
          log(
            `anchor: ${captured.fileName} page ${captured.source.page} ` +
              `note=${captured.isNote} rect=${JSON.stringify(captured.rect)}`,
          );
          // The last book is remembered because a book lookup needs to name it.
          if (!captured.isNote && settingsRef.current.lastBook !== captured.source.path) {
            changeRef.current({lastBook: captured.source.path});
          }
          // Measure the highlight drift while a document is actually open,
          // which is the only time it can be measured -- the settings screen
          // has none, which is why asking there hung. Once per run, in the
          // background, and it writes nothing.
          if (!captured.isNote && settingsRef.current.cloudToken && !calibrated.current) {
            calibrated.current = true;
            void calibrate(settingsRef.current.cloudToken, captured.source.path, pageText).catch(
              err => log(`calibrate: ${err instanceof Error ? err.message : String(err)}`),
            );
          }
        } catch (err) {
          log(`anchor: unavailable (${err instanceof Error ? err.message : String(err)})`);
        }

        const read =
          buttonId === DOC_SELECTION_BUTTON
            ? await readDocSelectionAsQuery()
            : await readLassoAsQuery().then(text => ({query: text, full: text}));
        // What the box shows is what will be searched; what is quoted is the
        // whole selection, which may be longer than a sensible query.
        setQuery(read.query);
        setSelection(read.full);
        const asked = withBookContext(
          read.query,
          capturedAnchor,
          settingsRef.current.bookQuery === 'withBook',
        );
        await search(asked, lensRef.current);
      } catch (err) {
        // Not an error worth shouting about — opening the panel with nothing
        // selected is a reasonable way to start a search by hand.
        setStatus(err instanceof Error ? err.message : 'Nothing to look up.');
      }
    },
    [search],
  );

  /** Why the panel opened in the first place. */
  useEffect(() => {
    (async () => {
      const buttonId = takePendingButton();
      const fromConfig = takePendingConfig();
      log(
        `mount: button=${buttonId} config=${fromConfig} ` +
          `nativeLog=${LOG_AVAILABLE} web=${WEB_AVAILABLE}`,
      );

      // Before anything else, so the rest of this run reaches the log file
      // rather than only the console.
      try {
        await ensureFileWrite();
      } catch (err) {
        log(`ensureFileWrite threw: ${err instanceof Error ? err.message : String(err)}`);
      }
      // After the permission, since the file lives in shared storage.
      const loaded = await loadSettings();
      settingsRef.current = loaded;
      setSettings(loaded);
      // Before the lookup runs, not after: this is the whole point of
      // remembering the lens, and startFromButton reads it immediately.
      const remembered = lensById(loaded.lens);
      lensRef.current = remembered;
      setLens(remembered);
      log(`settings: lens=${loaded.lens} bookQuery=${loaded.bookQuery}`);
      // Asked once, quietly, at the start. A session lasts thirty days and
      // lapses while nobody is looking; finding out at the moment you meant to
      // keep something is the worst time to find out.
      if (loaded.cloudToken) {
        void sessionIsGood(loaded.cloudToken).then(good => {
          if (good === false) {
            changeRef.current({cloudToken: ''});
            setStatus('Your Supernote sign-in has expired — sign in again in Settings.');
          }
        });
      }
      if (fromConfig) {
        // Opened to be configured, not to look anything up. Starting a lookup
        // as well would put a search behind the settings for no reason.
        setShowSettings(true);
        return;
      }
      await startFromButton(buttonId);
    })();
    // Deliberately once: this is the "why did the panel open" step, and
    // re-running it on every change of startFromButton would repeat the lookup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Later presses, while the panel is already up.
   *
   * A second lookup clears the draft, so it asks first when there is one.
   * Answering yes runs the lookup that prompted the question, not the next one.
   */
  useEffect(
    () =>
      onButtonPress((buttonId: number | null) => {
        if (unsavedRef.current) {
          setConfirm({
            question: 'You have text you have not kept. Start a new lookup anyway?',
            act: () => {
              setUnsaved(false);
              void startFromButton(buttonId);
            },
          });
          return;
        }
        void startFromButton(buttonId);
      }),
    [startFromButton],
  );

  /** The management screen's settings button, pressed while the panel is up. */
  useEffect(() => onConfigPress(() => setShowSettings(true)), []);

  /**
   * Close the panel now that the note has what it came for.
   *
   * After a short pause: the write has just happened, and closing in the same
   * frame leaves the reader with no chance to say it worked before the page
   * underneath comes back.
   */
  /**
   * What the chosen passages say, in document order.
   *
   * Shared by the draft and by what is written, so what is saved is what was
   * read on screen rather than a second composition of the same thing.
   */
  /**
   * The passages currently on screen, top to bottom.
   *
   * A passage counts as on screen when any part of it is, so one half scrolled
   * past is kept rather than dropped -- the alternative loses exactly the line
   * somebody was reading when they pressed the button.
   */
  const visibleText = useCallback((): string => {
    if (!page) {
      return '';
    }
    const {scrollY, height} = viewport.current;
    const bottom = scrollY + height;
    const shown: number[] = [];
    for (let i = 0; i < page.blocks.length; i += 1) {
      const box = blockAt.current.get(i);
      if (box && box.y < bottom && box.y + box.height > scrollY) {
        shown.push(i);
      }
    }
    log(`capture: ${shown.length} of ${page.blocks.length} passages are on screen`);
    return shown
      .map(i => blockText(page.blocks[i]))
      .filter(Boolean)
      .join('\n\n');
  }, [page]);

  /**
   * The passages to draw, each with the index it has in the page.
   *
   * The index travels with the block because everything else -- what is picked,
   * where a block was laid out -- is keyed by position in the page rather than
   * position on screen, and hiding the links changes only the second.
   */
  const shown = useCallback((): {block: Block; index: number}[] => {
    if (!page) {
      return [];
    }
    const all = page.blocks.map((block, index) => ({block, index}));
    if (!hideLinks) {
      return all;
    }
    return all.filter(entry => !entry.block.href);
  }, [hideLinks, page]);

  /** The whole page as one piece of text, in the order it is drawn. */
  const pageAsText = useCallback((): string => {
    return shown()
      .map(entry => blockText(entry.block))
      .filter(Boolean)
      .join('\n\n');
  }, [shown]);

  const chosenText = useCallback((): string => {
    if (!page) {
      return '';
    }
    return [...picked]
      .sort((a, b) => a - b)
      .map(i => blockText(page.blocks[i]))
      .filter(Boolean)
      .join('\n\n');
  }, [page, picked]);

  /**
   * Keep the draft in step with what has been chosen, until it is edited.
   *
   * Once somebody has cut a paragraph down to the sentence they wanted,
   * choosing another passage must add to that rather than throw it away.
   */
  useEffect(() => {
    if (!noteTouched.current) {
      setNote(chosenText());
    }
  }, [chosenText]);

  /**
   * Do something that would lose the draft, asking first if there is one.
   *
   * The prompt is drawn in the panel rather than raised as a dialog: a second
   * Android window costs a full e-ink refresh to appear and another to go, on
   * a screen where that is the slowest thing there is.
   */
  unsavedRef.current = unsaved;

  const guard = useCallback(
    (question: string, act: () => void) => {
      if (!unsaved) {
        act();
        return;
      }
      setConfirm({question, act});
    },
    [unsaved],
  );

  const finish = useCallback(() => {
    setTimeout(() => PluginManager.closePluginView(), CLOSE_DELAY);
  }, []);

  /**
   * The next ten results for the search already showing.
   *
   * A result list is one page deep unless it is asked for more, and the first
   * ten are often the wrong ten. Kept as a separate action rather than an
   * endless scroll: fetching on scroll would be a repaint on a display that
   * charges dearly for them.
   */
  const showMore = useCallback(async () => {
    // Two ways forward, because search engines differ. Wikipedia and Wiby take
    // an offset in the address; DuckDuckGo's next page is a form it hands out
    // with the current one, carrying tokens that only work once.
    if (page?.next) {
      setLoading(true);
      setStatus(null);
      try {
        log(`more: posting to ${page.next.url}`);
        const response = await postForm(page.next.url, page.next.body);
        const parsed = parse(response.body, page.next.url);
        if (parsed.blocks.length === 0) {
          setStatus('No more results.');
          return;
        }
        setHistory(prev => (url ? [...prev, url] : prev));
        setUrl(page.next.url);
        setPage(parsed);
        setPicked([]);
        setResultPage(current => current + 1);
        scrollRef.current?.scrollTo({y: 0, animated: false});
        blockAt.current.clear();
        viewport.current.scrollY = 0;
      } catch (err) {
        setStatus(`Could not fetch more: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setLoading(false);
      }
      return;
    }
    if (!lens.more || !query.trim()) {
      return;
    }
    const next = resultPage + 1;
    setResultPage(next);
    log(`more: ${lens.id} page ${next}`);
    await open(lens.more(query, resultPage));
  }, [lens, open, page, query, resultPage, url]);

  const back = useCallback(() => {
    const previous = history[history.length - 1];
    if (!previous) {
      // Nothing left to go back to, so this leaves. Answer it here rather than
      // letting the panel close over unkept work.
      if (unsaved) {
        setConfirm({
          question: 'You have text you have not kept. Leave anyway?',
          act: () => PluginManager.closePluginView(),
        });
        return true;
      }
      return false;
    }
    setHistory(prev => prev.slice(0, -1));
    open(previous);
    return true;
  }, [history, open, unsaved]);

  /** Hardware/system back should walk the reader's history before closing. */
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', back);
    return () => sub.remove();
  }, [back]);

  /** Follow a link from a result list or an article. */
  const follow = useCallback(
    (href: string) => {
      // Logged because "the arrow went somewhere else" is otherwise
      // indistinguishable in a log from "the arrow was missed and the passage
      // got picked instead" -- the two have opposite fixes.
      log(`follow: ${href}`);
      if (url) {
        setHistory(prev => [...prev, url]);
      }
      open(href);
    },
    [open, url],
  );

  /**
   * Tapping a block marks it for quoting.
   *
   * Chosen over dragging a text selection because this is a stylus on e-ink:
   * selection handles are fiddly, every drag costs a repaint, and React Native
   * gives no way to read back what was selected anyway. A whole paragraph is
   * also usually the right quantum for a quote.
   */
  const toggle = useCallback((index: number) => {
    setPicked(prev =>
      prev.includes(index) ? prev.filter(i => i !== index) : [...prev, index],
    );
  }, []);

  /**
   * Every address the current selection points at.
   *
   * Each chosen result carries its own, and each becomes its own link. Falls
   * back to the page being read when nothing chosen has one — a lookup that
   * kept no address at all would be the one thing worse than too many.
   */
  const chosenUrls = useCallback(
    (indices?: number[]): string[] => {
      const from = indices ?? [...picked].sort((a, b) => a - b);
      const fromBlocks = from
        .map(i => page?.blocks[i]?.href)
        .filter((href): href is string => Boolean(href));
      if (fromBlocks.length > 0) {
        return fromBlocks;
      }
      const fallback = page?.viewerUrl ?? url;
      return fallback ? [fallback] : [];
    },
    [page, picked, url],
  );

  /** Write the chosen passages into the note the lookup started from. */
  const insert = useCallback(async () => {
    // A draft counts, not only tapped passages. Capture fills the draft
    // without picking anything, and the button that keeps it was hidden --
    // so text could be captured, edited, and then had nowhere to go.
    if (!page || !anchor || (picked.length === 0 && !note.trim())) {
      return;
    }
    // Document order, not the order they happened to be tapped in.
    // The draft, not a fresh composition of the chosen blocks: an edit made
    // above is the whole point of offering one.
    const text = (note.trim() || chosenText()).trim();
    if (!text) {
      return;
    }
    setBusy(true);
    setStatus(anchor.isNote ? 'Writing in…' : 'Adding to the digest…');
    try {
      // A note is written into directly. A book cannot be: every PluginNoteAPI
      // write is refused outright when the app in front is DOC. That is not a
      // limit on digests -- the firmware's own digest does not write into the
      // PDF either, it collects excerpts into a note -- so a book takes the
      // same route by a different API.
      let failure: string | null;
      if (anchor.isNote) {
        failure = await insertPassages(anchor, text, {
          reference: reference(anchor),
          urls: chosenUrls(),
        });
      } else if (!settings.cloudToken) {
        // A book's own markup is unreachable: locked (1206) while the book is
        // open, forbidden (102) once it is closed. The device's own Digest is
        // where these belong, and Supernote's service is the only way in.
        failure =
          'sign in to Supernote Cloud in Settings, and this will go into your Digest';
      } else {
        try {
          // How the device identifies the book, and where in the page the
          // passage sits. Both are what its own digests carry, and both are
          // read here rather than assumed.
          const [identity, positions] = await Promise.all([
            fileInfo(anchor.source.path),
            positionInPage(anchor.source.page, selection || query),
          ]);
          const id = await addBookDigest(
            settings.cloudToken,
            selection || query,
            text,
            anchor.source.path,
            anchor.source.page,
            reference(anchor),
            chosenUrls(),
            identity,
            positions,
          );
          log(`digest: created ${id} from ${anchor.fileName}`);
          setPicked([]);
      setUnsaved(false);
          setStatus('Added to your Digest.');
          finish();
          return;
        } catch (err) {
          if (isExpired(err)) {
            changeRef.current({cloudToken: ''});
          }
          failure = err instanceof Error ? err.message : 'Supernote would not take that.';
        }
      }
      if (failure) {
        log(`insert failed: ${failure}`);
        setStatus(`Could not keep that: ${failure}`);
        return;
      }
      setPicked([]);
      setStatus(anchor.isNote ? 'Written in.' : 'Added to the digest.');
      finish();
    } finally {
      setBusy(false);
    }
  }, [anchor, chosenText, chosenUrls, finish, note, page, picked, query, selection, settings]);

  /**
   * Draw the chosen passages as an image and hang it off the handwriting.
   *
   * The whole page is used when nothing has been picked: having read something
   * worth keeping, being made to tap every paragraph first would be a chore.
   */
  const clip = useCallback(async () => {
    if (!page || !anchor) {
      return;
    }
    const chosen = picked.length > 0 ? [...picked].sort((a, b) => a - b) : null;
    // Capped, because a page can be enormous: an unpicked clip of one article
    // ran to 1,315 passages and drew an image 113,000 pixels tall.
    const kept = chosen ?? page.blocks.map((_, i) => i).slice(0, MAX_UNPICKED);
    // Each passage carries its own address, so a clipping of several results
    // says which one said what.
    const sections: ClipSection[] = kept
      .map(i => page.blocks[i])
      .filter((block): block is Block => Boolean(block))
      .map(block => ({
        heading: block.text,
        url: block.href ?? '',
        body: block.detail ?? '',
      }));
    if (sections.length === 0) {
      return;
    }

    const mode = captureMode(settings);
    if (!mode) {
      setStatus('Nothing to insert — turn on the clipping or the page link in Settings.');
      return;
    }
    setBusy(true);
    setStatus('Inserting…');
    try {
      const failure = await attachClip(anchor, {
        mode,
        title: page.title || query,
        // Two lines: where the lookup started, then where the text came from.
        source: [reference(anchor), page.viewerUrl ?? url ?? ''].filter(Boolean).join('\n'),
        sections,
        // Only what was chosen. Passing every clipped block put a link under the
        // handwriting for each of them -- six identical "7esl.com" labels from
        // one article -- where what is wanted is the page that was read.
        sourceUrls: chosenUrls(chosen ?? undefined),
        notesLabel: labelOr(settings.notesLabel, DEFAULT_SETTINGS.notesLabel),
        folder: settings.clipFolder,
      });
      if (failure) {
        log(`clip failed: ${failure}`);
        setStatus(`Could not attach the clipping: ${failure}`);
        return;
      }
      setPicked([]);
      setUnsaved(false);
      setStatus('Links inserted.');
      finish();
    } finally {
      setBusy(false);
    }
  }, [anchor, chosenUrls, finish, page, picked, query, settings, url]);

  /**
   * Read the passages on screen into the editor.
   *
   * The words rather than a picture of them, because that is what can be kept
   * anywhere: a digest holds text and a note takes it as a text box. Identical
   * in a note and in a book, so there is one behaviour to learn and one to
   * test.
   */
  const captureText = useCallback(() => {
    // Three sources, narrowest first: a real selection, then whatever was
    // tapped, then what happens to be on screen. Each is a more deliberate
    // statement of intent than the one after it.
    const selected =
      selecting && range.end > range.start
        ? pageAsText().slice(range.start, range.end).trim()
        : '';
    const shown = selected || chosenText() || visibleText();
    if (!shown) {
      setStatus('Nothing selected or on screen to capture yet.');
      return;
    }
    // Replaces what was there. Adding to it meant a capture taken on one page
    // was still in the editor two pages later, which reads as the button
    // having done nothing -- and the draft is guarded, so an edited one asks
    // before it goes.
    guard('Replace the text you have not kept yet?', () => {
      noteTouched.current = true;
      setUnsaved(true);
      setNote(shown);
      setEditingNote(true);
      setStatus('Captured what is on screen — trim it, then keep it.');
    });
  }, [chosenText, guard, pageAsText, range, selecting, visibleText]);

  /** Photograph the reader as it stands, and hang the picture off the writing. */
  const screenshot = useCallback(async () => {
    const tag = findNodeHandle(readerRef.current);
    if (tag === null || !anchor) {
      setStatus('There is nothing on screen to capture.');
      return;
    }

    const mode = captureMode(settings);
    if (!mode) {
      setStatus('Nothing to insert — turn on the clipping or the page link in Settings.');
      return;
    }
    setBusy(true);
    setStatus('Capturing…');
    try {
      const failure = await attachScreenshot(
        anchor,
        tag,
        chosenUrls(),
        mode,
        labelOr(settings.notesLabel, DEFAULT_SETTINGS.notesLabel),
        settings.clipFolder,
      );
      if (failure) {
        log(`screenshot failed: ${failure}`);
        setStatus(`Could not attach the screenshot: ${failure}`);
        return;
      }
      setStatus('Captured.');
      finish();
    } finally {
      setBusy(false);
    }
  }, [anchor, chosenUrls, finish, settings]);

  const handOff = useCallback(async () => {
    // Wikipedia is read through its API, so what was fetched is not what a
    // person should be handed.
    const target = page?.viewerUrl ?? url;
    if (!target) {
      return;
    }
    try {
      await openExternally(target);
      // Deliberately left open. Closing here meant handing a page to the viewer
      // and losing every way to keep anything from it -- the passages, the
      // anchor and the lasso rectangle all live in this panel, and none of them
      // survive it closing. The viewer covers it; coming back finds it as it
      // was, with whatever was already chosen still chosen.
      setStatus('Opened in the viewer. Come back here to keep anything from it.');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Nothing here can open that.');
    }
  }, [page, url]);

  // A screen of its own. Drawn inline above the reader it sat on top of every
  // search that followed, took half the display and could not be dismissed.
  if (showSettings) {
    return (
      <SettingsScreen
        settings={settings}
        onChange={change}
        // Both leave. Settings are opened from the device's plugin management
        // screen, so finishing with them means going back there -- landing in
        // the lookup panel is a place nobody asked to be.
        onDone={() => PluginManager.closePluginView()}
        onClose={() => PluginManager.closePluginView()}
      />
    );
  }

  return (
    <View style={styles.root}>
      {confirm ? (
        <View style={styles.confirm}>
          <Text style={styles.confirmText}>{confirm.question}</Text>
          <View style={styles.confirmRow}>
            {/* Cancel first and set like a real button. It was second, in the
                plain style, and read as a caption rather than a way out. */}
            <TouchableOpacity style={styles.confirmCancel} onPress={() => setConfirm(null)}>
              <Text style={styles.confirmCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.confirmGo}
              onPress={() => {
                const act = confirm.act;
                setConfirm(null);
                act();
              }}>
              <Text style={styles.confirmGoText}>Discard</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
      <View style={styles.bar}>
        <TouchableOpacity
          style={[styles.btn, history.length === 0 && styles.btnOff]}
          disabled={history.length === 0}
          onPress={back}>
          <Text style={styles.btnText}>‹ Back</Text>
        </TouchableOpacity>

        <View style={styles.inputWrap}>
          <TextInput
            style={styles.input}
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={() => search(query, lensRef.current)}
            placeholder="Search, or type an address"
            returnKeyType="search"
            autoCorrect={false}
          />
          {query.length > 0 ? (
            <TouchableOpacity style={styles.clear} onPress={() => setQuery('')}>
              <Text style={styles.clearText}>✕</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {/* Says where a plain word would go if this is pressed, and takes it
            there. Typing an address is recognised on its own, but only when it
            looks like one -- this asks for it outright, so a bare host or a
            site whose name reads like a search is never guessed wrong. */}
        <TouchableOpacity
          style={styles.goBtn}
          onPress={() => {
            const typed = query.trim();
            if (!typed) {
              return;
            }
            const address = /^https?:\/\//i.test(typed) ? typed : `https://${typed}`;
            log(`address: ${address}`);
            setHistory([]);
            setResultPage(1);
            void open(address);
          }}>
          <Text style={styles.goText}>https://</Text>
        </TouchableOpacity>

        {/* No Settings button here. Settings open from the device's plugin
            management screen, beside the install and the permissions, which is
            where a person goes to change how a plugin behaves -- this panel is
            opened from a lasso to do one thing and closed again. */}
        {showSettings ? (
          <TouchableOpacity style={styles.btn} onPress={() => setShowSettings(false)}>
            <Text style={styles.btnText}>Done</Text>
          </TouchableOpacity>
        ) : null}

        <TouchableOpacity
          style={styles.btn}
          onPress={() =>
            guard('You have text you have not kept. Close anyway?', () =>
              PluginManager.closePluginView(),
            )
          }>
          <Text style={styles.btnText}>Close</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.lenses}>
        {LENSES.map(l => (
          <TouchableOpacity
            key={l.id}
            style={[styles.lens, l.id === lens.id && styles.lensOn]}
            onPress={() => {
              chooseLens(l);
              search(query, l);
            }}>
            <Text style={[styles.lensText, l.id === lens.id && styles.lensTextOn]}>
              {l.label}
            </Text>
            {/* Under each one, not only the chosen one: four buttons that all
                say "search" are told apart by what is written beneath them. */}
            <Text style={[styles.lensShort, l.id === lens.id && styles.lensTextOn]}>
              {l.short}
            </Text>
          </TouchableOpacity>
        ))}
        <View style={styles.spacer} />
        {page ? (
          <TouchableOpacity
            style={[styles.lens, selecting && styles.lensOn]}
            onPress={() => {
              setSelecting(v => !v);
              setRange({start: 0, end: 0});
            }}>
            <Text style={[styles.lensText, selecting && styles.lensTextOn]}>
              {selecting ? 'Selecting' : 'Select text'}
            </Text>
            <Text style={[styles.lensShort, selecting && styles.lensTextOn]}>
              {selecting ? 'Drag, then Capture' : 'Drag over what you want'}
            </Text>
          </TouchableOpacity>
        ) : null}
        {page?.blocks.some(block => block.href) ? (
          <TouchableOpacity
            style={[styles.lens, hideLinks && styles.lensOn]}
            onPress={() => setHideLinks(v => !v)}>
            <Text style={[styles.lensText, hideLinks && styles.lensTextOn]}>
              {hideLinks ? 'Links hidden' : 'Hide links'}
            </Text>
            <Text style={[styles.lensShort, hideLinks && styles.lensTextOn]}>
              {hideLinks ? 'Prose only' : 'Show the text alone'}
            </Text>
          </TouchableOpacity>
        ) : null}
        {url ? (
          <TouchableOpacity style={styles.lens} onPress={handOff}>
            <Text style={styles.lensText}>Open in viewer</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {settings.refinements.length > 0 && query.trim() ? (
        <ScrollView horizontal style={styles.refine} showsHorizontalScrollIndicator={false}>
          {settings.refinements.map(word => (
            <TouchableOpacity
              key={word}
              style={styles.refineBtn}
              onPress={() => {
                // Added rather than replacing, and only once: pressing the same
                // one twice should not search for it twice.
                const already = query.trim().toLowerCase().endsWith(word.toLowerCase());
                const asked = already ? query.trim() : `${query.trim()} ${word}`;
                setQuery(asked);
                void search(asked, lensRef.current);
              }}>
              <Text style={styles.refineText}>+ {word}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      ) : null}

      <Text style={styles.hint} numberOfLines={2}>
        {status ?? (url ? `${page?.title ?? ''} — ${hostOf(url)}` : lens.hint)}
      </Text>
      {anchor ? (
        // Shown while reading as well as printed on the clipping: it is the
        // answer to "what was I looking this up for" a month later.
        <Text style={styles.reference} numberOfLines={1}>
          {reference(anchor)}
        </Text>
      ) : null}

      {editingNote ? (
        // In place of the reader rather than below it. The on-screen keyboard
        // takes the bottom half of the display, and an editor sitting above the
        // footer is precisely what it covers -- so it goes where the reading
        // was, at the top, where nothing can be over it.
        <View style={styles.editor}>
          <View style={styles.editorHead}>
            <Text style={styles.noteLabel}>Trim this to the part worth keeping</Text>
            <View style={styles.spacer} />
            <TouchableOpacity
              style={styles.btn}
              onPress={() => {
                noteTouched.current = false;
                setNote(chosenText());
              }}>
              <Text style={styles.btnText}>Reset</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.btn} onPress={() => setEditingNote(false)}>
              <Text style={styles.btnText}>Done</Text>
            </TouchableOpacity>
          </View>
          <TextInput
            style={styles.noteInput}
            value={note}
            onChangeText={value => {
              noteTouched.current = true;
              setUnsaved(true);
              setNote(value);
            }}
            multiline
            autoFocus
            autoCorrect={false}
          />
        </View>
      ) : null}

      <View
        style={[styles.body, editingNote && styles.hidden]}
        ref={readerRef}
        collapsable={false}>
        {page && selecting ? (
          // The page as one field. Read-only in effect -- edits here would have
          // nothing to be saved into -- but a real text field, so the device's
          // own selection handles work and what they enclose can be read back.
          <TextInput
            style={styles.selectable}
            value={pageAsText()}
            onSelectionChange={event => setRange(event.nativeEvent.selection)}
            multiline
            showSoftInputOnFocus={false}
            autoCorrect={false}
          />
        ) : page && shown().length > 0 ? (
          <ScrollView
            ref={scrollRef}
            style={styles.scroll}
            contentContainerStyle={styles.scrollInner}
            scrollEventThrottle={100}
            onScroll={event => {
              viewport.current.scrollY = event.nativeEvent.contentOffset.y;
            }}
            onLayout={event => {
              viewport.current.height = event.nativeEvent.layout.height;
            }}>
            {shown().map(({block, index}) => (
              <Passage
                key={`${index}-${block.text.slice(0, 24)}`}
                block={block}
                onMeasured={(y, height) => blockAt.current.set(index, {y, height})}
                picked={picked.includes(index)}
                onPick={() => toggle(index)}
                onFollow={block.href ? () => follow(block.href!) : undefined}
              />
            ))}
          </ScrollView>
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              Lasso some handwriting, or write a search above.
            </Text>
          </View>
        )}
        {loading && (
          <View style={styles.loading} pointerEvents="none">
            <ActivityIndicator size="large" />
          </View>
        )}
      </View>

      {page && page.blocks.length > 0 && (
        <>
        <View style={styles.footer}>
          {/* On its own line above the buttons. Sharing a row with them, a long
              message -- and a refusal is always long -- pushed every button off
              the edge of the screen, which read as the buttons not existing. */}
          <Text style={styles.footerText} numberOfLines={3}>
            {/* The reason a button did nothing belongs beside the button. The
                header line carries it too, and a refusal read at the top of the
                panel while looking at the bottom of it reads as silence. */}
            {status ??
              (picked.length === 0
                ? 'Tap passages to choose them'
                : `${picked.length === 1 ? '1 passage' : `${picked.length} passages`} chosen`)}
          </Text>
          <View style={styles.footerButtons}>
          {page.blocks.some(block => block.kind === 'result') && (lens.more || page.next) ? (
            <TouchableOpacity style={styles.btn} onPress={() => void showMore()}>
              <Text style={styles.btnText}>More results</Text>
            </TouchableOpacity>
          ) : null}
          {picked.length > 0 && (
            <TouchableOpacity style={styles.btn} onPress={() => setPicked([])}>
              <Text style={styles.btnText}>Clear</Text>
            </TouchableOpacity>
          )}
          {(picked.length > 0 || note.trim().length > 0) && (
            <TouchableOpacity
              style={styles.btn}
              onPress={() => setEditingNote(v => !v)}>
              <Text style={styles.btnText}>{editingNote ? 'Hide text' : 'Edit text'}</Text>
            </TouchableOpacity>
          )}
          {(picked.length > 0 || note.trim().length > 0) && anchor && (
            <TouchableOpacity style={styles.insert} onPress={insert} disabled={busy}>
              <Text style={styles.insertText}>
                {anchor.isNote ? 'Paste selected text' : 'Add to Digest'}
              </Text>

            </TouchableOpacity>
          )}
          {/* The same button, doing the same thing, whichever the lookup began
              in: it reads the passages on screen into the editor. Having it
              only in a book meant the two halves of the plugin had to be
              learnt, and tested, separately. */}
          <TouchableOpacity
            style={[styles.insert, busy && styles.btnOff]}
            onPress={captureText}
            disabled={busy}>
            <Text style={styles.insertText}>Capture text</Text>
          </TouchableOpacity>
          {anchor?.isNote && CLIP_AVAILABLE && (
            <TouchableOpacity
              style={[styles.insert, busy && styles.btnOff]}
              onPress={screenshot}
              disabled={busy}>
              <Text style={styles.insertText}>Screenshot</Text>
            </TouchableOpacity>
          )}
          {anchor?.isNote && CLIP_AVAILABLE && (
            <TouchableOpacity
              style={[styles.insert, busy && styles.btnOff]}
              onPress={clip}
              disabled={busy}>
              <Text style={styles.insertText}>Insert links</Text>
            </TouchableOpacity>
          )}
          </View>
        </View>
        </>
      )}
    </View>
  );
}

/** A block as text, including a result's snippet. */
function blockText(block: Block | undefined): string {
  if (!block) {
    return '';
  }
  return block.detail ? `${block.text}\n${block.detail}` : block.text;
}

/**
 * One block of the page.
 *
 * A block that is a link gets two targets: the text quotes it, a separate
 * chevron follows it. Combining them would make every quote a navigation and
 * lose the passage the reader wanted.
 */
function Passage({
  block,
  picked,
  onPick,
  onFollow,
  onMeasured,
}: {
  block: Block;
  picked: boolean;
  onPick(): void;
  onFollow?: () => void;
  /** Where this passage ended up, so "what is on screen" can be worked out. */
  onMeasured?: (y: number, height: number) => void;
}): React.JSX.Element {
  return (
    <View
      style={[styles.block, picked && styles.blockPicked]}
      onLayout={event =>
        onMeasured?.(event.nativeEvent.layout.y, event.nativeEvent.layout.height)
      }>
      <TouchableOpacity style={styles.blockText} onPress={onPick} activeOpacity={0.6}>
        <Text
          style={[
            block.kind === 'heading' ? styles.heading : styles.paragraph,
            block.kind === 'result' && styles.resultTitle,
            picked && styles.pickedText,
          ]}>
          {block.text}
        </Text>
        {block.href ? (
          // The address is set heavier than anything around it. On a greyscale
          // screen weight is the only reliable signal — a tint or a colour is
          // indistinguishable from the body text beside it — and knowing what
          // is a link is what decides whether tapping it goes somewhere.
          <View style={styles.linkRow}>
            <Text style={[styles.linkTag, picked && styles.pickedTag]}>LINK</Text>
            {/* The whole address, not just the host. Two results from one site
                showed as the same line, so which one an arrow would open was
                impossible to tell before tapping it. */}
            <Text style={[styles.address, picked && styles.pickedText]} numberOfLines={2}>
              {block.href}
            </Text>
          </View>
        ) : null}
        {block.detail ? (
          <Text style={[styles.detail, picked && styles.pickedText]}>{block.detail}</Text>
        ) : null}
      </TouchableOpacity>
      {onFollow ? (
        <TouchableOpacity style={styles.followBtn} onPress={onFollow}>
          <Text style={[styles.followText, picked && styles.pickedText]}>›</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

// High-contrast, heavy borders and large tap targets: this is a 16-level
// greyscale display being read in reflected light, so mid-greys and thin
// hairlines that look fine on an LCD disappear entirely.
const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#fff'},
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 8,
    borderBottomWidth: 2,
    borderBottomColor: '#000',
  },
  btn: {paddingHorizontal: 14, paddingVertical: 12},
  btnOff: {opacity: 0.35},
  btnText: {fontSize: 18, color: '#000', fontWeight: '600'},
  inputWrap: {flex: 1, flexDirection: 'row', alignItems: 'center'},
  clear: {paddingHorizontal: 12, paddingVertical: 10, marginLeft: -46},
  clearText: {fontSize: 22, color: '#000'},
  goBtn: {
    borderWidth: 2,
    borderColor: '#000',
    paddingHorizontal: 10,
    paddingVertical: 10,
    marginLeft: 6,
  },
  goText: {fontSize: 15, color: '#000', fontWeight: '700'},
  input: {
    flex: 1,
    borderWidth: 2,
    borderColor: '#000',
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 16,
    color: '#000',
  },
  lenses: {
    flexWrap: 'wrap',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#000',
  },
  lens: {
    alignItems: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 6,
    borderWidth: 1,
    borderColor: '#000',
  },
  lensOn: {backgroundColor: '#000'},
  lensText: {fontSize: 14, color: '#000'},
  lensTextOn: {color: '#fff'},
  spacer: {flex: 1},
  lensShort: {fontSize: 12, color: '#000', marginTop: 2},
  selectable: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 17,
    lineHeight: 25,
    color: '#000',
    textAlignVertical: 'top',
  },
  refine: {flexGrow: 0, paddingHorizontal: 8, paddingVertical: 6},
  refineBtn: {
    borderWidth: 2,
    borderColor: '#000',
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginRight: 8,
  },
  refineText: {fontSize: 16, color: '#000', fontWeight: '600'},
  hint: {paddingHorizontal: 12, paddingVertical: 6, fontSize: 13, color: '#000'},
  reference: {paddingHorizontal: 12, paddingBottom: 4, fontSize: 12, color: '#000'},
  body: {flex: 1},
  scroll: {flex: 1},
  scrollInner: {paddingBottom: 40},
  block: {flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 12},
  // Text settings are typed rather than chosen, so they get a box that looks
  // like one: on e-ink an unbordered input is indistinguishable from a label.
  browseBtn: {marginTop: 4},
  field: {
    borderWidth: 2,
    borderColor: '#000',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 4,
    fontSize: 18,
    color: '#000',
  },
  // Inverted rather than tinted: a light grey wash is invisible on this display.
  blockPicked: {backgroundColor: '#000'},
  // Paired with blockPicked — without it the text is black on black.
  pickedText: {color: '#fff'},
  blockText: {flex: 1, paddingVertical: 8},
  // Prose is the thing being read, so it is set plainly and comfortably; the
  // weight in this design is reserved for addresses, which are what a reader
  // needs to pick out at a glance.
  heading: {fontSize: 19, fontWeight: '600', color: '#000'},
  paragraph: {fontSize: 16, lineHeight: 24, color: '#000', fontWeight: '400'},
  resultTitle: {fontSize: 17, fontWeight: '500'},
  detail: {fontSize: 15, lineHeight: 22, color: '#000', fontWeight: '400', marginTop: 3},
  // Where a result actually goes. Shown in the reader for the same reason it is
  // printed in the clipping: a list of titles says nothing about their sources.
  address: {fontSize: 15, fontWeight: '800', color: '#000', flexShrink: 1},
  linkRow: {flexDirection: 'row', alignItems: 'center', marginTop: 4},
  linkTag: {
    fontSize: 11,
    fontWeight: '800',
    color: '#000',
    borderWidth: 1,
    borderColor: '#000',
    paddingHorizontal: 4,
    paddingVertical: 1,
    marginRight: 6,
  },
  pickedTag: {color: '#fff', borderColor: '#fff'},
  settings: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: '#000',
    // Bounded because it scrolls now: left to grow it pushes the reader off the
    // bottom of the panel, which on a screen this size hides what is being read.
    maxHeight: 520,
  },
  settingsSpacer: {height: 12},
  settingsTitle: {fontSize: 20, fontWeight: '700', color: '#000', marginBottom: 8, marginTop: 16},
  choice: {paddingVertical: 12, paddingHorizontal: 14, borderWidth: 2, borderColor: '#000', marginBottom: 8},
  choiceOn: {backgroundColor: '#000'},
  choiceLabel: {fontSize: 19, color: '#000', fontWeight: '600'},
  choiceHint: {fontSize: 16, color: '#000', marginTop: 4},
  // Bordered and large. This was a bare chevron with modest padding, which on
  // e-ink read as decoration rather than a control and was easy to miss
  // entirely -- a miss lands on the quote instead and picks it, so the tap
  // appears to do the wrong thing rather than nothing.
  followBtn: {
    minWidth: 64,
    minHeight: 64,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#000',
    marginLeft: 8,
    marginVertical: 8,
  },
  followText: {fontSize: 34, lineHeight: 38, color: '#000'},
  empty: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24},
  emptyText: {fontSize: 16, color: '#000', textAlign: 'center'},
  loading: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footerButtons: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginTop: 6},
  // Tall enough to work in, bounded so the reader behind it is still visible.
  // Inverted so it cannot be mistaken for part of the page behind it.
  confirm: {
    backgroundColor: '#000',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 2,
    borderBottomColor: '#000',
  },
  confirmText: {fontSize: 17, color: '#fff', marginBottom: 8},
  confirmRow: {flexDirection: 'row', alignItems: 'center'},
  confirmCancel: {
    backgroundColor: '#fff',
    paddingHorizontal: 20,
    paddingVertical: 12,
    marginRight: 10,
  },
  confirmCancelText: {fontSize: 18, color: '#000', fontWeight: '700'},
  confirmGo: {
    borderWidth: 2,
    borderColor: '#fff',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  confirmGoText: {fontSize: 18, color: '#fff', fontWeight: '700'},
  editor: {flex: 1, paddingHorizontal: 12, paddingVertical: 8},
  editorHead: {flexDirection: 'row', alignItems: 'center', marginBottom: 6},
  // Kept mounted rather than unmounted: the reader holds the scroll position
  // and every passage's measurements, and rebuilding it would lose both.
  hidden: {height: 0, opacity: 0},
  noteLabel: {fontSize: 15, color: '#000', marginBottom: 6},
  noteInput: {
    borderWidth: 2,
    borderColor: '#000',
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 16,
    color: '#000',
    flex: 1,
    textAlignVertical: 'top',
  },
  footer: {
    alignItems: 'stretch',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 2,
    borderTopColor: '#000',
  },
  footerText: {fontSize: 15, color: '#000'},
  insert: {
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderWidth: 3,
    borderColor: '#000',
    backgroundColor: '#000',
    marginLeft: 8,
    marginTop: 6,
  },
  insertText: {fontSize: 19, color: '#fff', fontWeight: '700'},
});
