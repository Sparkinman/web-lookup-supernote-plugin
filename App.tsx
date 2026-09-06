/**
 * Look Up — a browser panel over a note.
 *
 * Opened by lassoing handwriting in NOTE or selecting text in DOC. The
 * selection becomes the query; the result is a normal web page you can read
 * without leaving the notebook. Text selected in the page can be written back
 * into the note, which is the whole point of doing this on the device rather
 * than reaching for a phone.
 */

import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  BackHandler,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {WebView, type WebViewNavigation} from 'react-native-webview';
import {PluginManager, PluginNoteAPI} from 'sn-plugin-lib';

import {readDocSelectionAsQuery, readLassoAsQuery} from './src/capture';
import {DEFAULT_LENS, LENSES, resolve, type Lens} from './src/search';
import {takePendingButton} from './index';

/** Button ids, matching index.js. 300 is the DOC text-selection entry. */
const DOC_SELECTION_BUTTON = 300;

/**
 * Reports the current text selection back to the plugin.
 *
 * Runs on every page. `document` selection is the only way to get at what the
 * reader has picked out — the WebView gives no native accessor for it.
 */
const SELECTION_BRIDGE = `
(function() {
  function report() {
    var s = String(window.getSelection() || '');
    window.ReactNativeWebView.postMessage(JSON.stringify({selection: s}));
  }
  document.addEventListener('selectionchange', report);
  document.addEventListener('mouseup', report);
  true;
})();
`;

export default function App(): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [lens, setLens] = useState<Lens>(DEFAULT_LENS);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [selection, setSelection] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  const webRef = useRef<WebView>(null);

  /**
   * Work out why the panel opened and seed the query from it.
   *
   * The button id is read from module scope rather than from a listener here:
   * PluginHost opens the view as soon as the button is pressed, which can be
   * before this component has mounted, so a listener registered at this point
   * would miss the event that caused the open.
   */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const buttonId = takePendingButton();
      try {
        const captured =
          buttonId === DOC_SELECTION_BUTTON
            ? await readDocSelectionAsQuery()
            : await readLassoAsQuery();
        if (cancelled) {
          return;
        }
        setQuery(captured);
        setUrl(resolve(captured, DEFAULT_LENS));
      } catch (err) {
        if (!cancelled) {
          // Not an error worth shouting about — opening the panel with nothing
          // selected is a reasonable way to start a search by hand.
          setStatus(err instanceof Error ? err.message : 'Nothing to look up.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /** Hardware/system back should walk the page history before closing. */
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBack && webRef.current) {
        webRef.current.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [canGoBack]);

  const search = useCallback(
    (text: string, withLens: Lens) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      setStatus(null);
      setUrl(resolve(trimmed, withLens));
    },
    [],
  );

  const onMessage = useCallback((event: {nativeEvent: {data: string}}) => {
    try {
      const payload = JSON.parse(event.nativeEvent.data);
      if (typeof payload?.selection === 'string') {
        setSelection(payload.selection.trim());
      }
    } catch {
      // A page of its own posting messages we did not send — ignore it rather
      // than letting a malformed payload take the panel down.
    }
  }, []);

  /** Write the selected passage into the note the lookup started from. */
  const insert = useCallback(async () => {
    if (!selection) {
      return;
    }
    try {
      // insertText always targets the page currently displayed in the host —
      // there is no page argument — which is the page the lasso came from,
      // since the panel does not navigate the note.
      await PluginNoteAPI.insertText(selection);
      await PluginNoteAPI.saveCurrentNote();
      setStatus('Inserted into the note.');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Could not insert that.');
    }
  }, [selection]);

  const close = useCallback(() => {
    PluginManager.closePluginView();
  }, []);

  return (
    <View style={styles.root}>
      <View style={styles.bar}>
        <TouchableOpacity
          style={[styles.btn, !canGoBack && styles.btnOff]}
          disabled={!canGoBack}
          onPress={() => webRef.current?.goBack()}>
          <Text style={styles.btnText}>‹ Back</Text>
        </TouchableOpacity>

        <TextInput
          style={styles.input}
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={() => search(query, lens)}
          placeholder="Write or type a search"
          returnKeyType="search"
          autoCorrect={false}
        />

        <TouchableOpacity style={styles.btn} onPress={close}>
          <Text style={styles.btnText}>Close</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.lenses}>
        {LENSES.map(l => (
          <TouchableOpacity
            key={l.id}
            style={[styles.lens, l.id === lens.id && styles.lensOn]}
            onPress={() => {
              setLens(l);
              search(query, l);
            }}>
            <Text style={[styles.lensText, l.id === lens.id && styles.lensTextOn]}>
              {l.label}
            </Text>
          </TouchableOpacity>
        ))}
        <View style={styles.spacer} />
        {selection.length > 0 && (
          <TouchableOpacity style={styles.insert} onPress={insert}>
            <Text style={styles.insertText}>Insert selection</Text>
          </TouchableOpacity>
        )}
      </View>

      <Text style={styles.hint}>{status ?? lens.hint}</Text>

      <View style={styles.page}>
        {url ? (
          <WebView
            ref={webRef}
            source={{uri: url}}
            originWhitelist={['https://*', 'http://*']}
            injectedJavaScript={SELECTION_BRIDGE}
            onMessage={onMessage}
            onLoadStart={() => setLoading(true)}
            onLoadEnd={() => setLoading(false)}
            onNavigationStateChange={(nav: WebViewNavigation) =>
              setCanGoBack(nav.canGoBack)
            }
            // e-ink redraws cost more than they do on LCD; letting the page
            // animate its own scrolling makes it worse, not smoother.
            decelerationRate="fast"
onRenderProcessGone={() => setStatus('The page stopped responding.')}
          />
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
  btn: {paddingHorizontal: 12, paddingVertical: 10},
  btnOff: {opacity: 0.3},
  btnText: {fontSize: 16, color: '#000'},
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
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#000',
  },
  lens: {
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
  insert: {paddingHorizontal: 12, paddingVertical: 6, borderWidth: 2, borderColor: '#000'},
  insertText: {fontSize: 14, color: '#000', fontWeight: '600'},
  hint: {paddingHorizontal: 12, paddingVertical: 6, fontSize: 13, color: '#000'},
  page: {flex: 1},
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
});
