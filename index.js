/**
 * Look Up — entry point
 *
 * Lasso handwriting on a NOTE page, or select text in DOC, and the selection
 * becomes a search query. Results come back as plain text in a panel, and a
 * passage can be written back into the note.
 *
 * @format
 */

import {AppRegistry, Image} from 'react-native';
import Root from './src/Root';
import {name as appName} from './app.json';

import {PluginManager} from 'sn-plugin-lib';
import {versionName, versionCode} from './PluginConfig.json';
import {log, startSession} from './src/log';

// MUST come before PluginManager.init() — init depends on the registered component.
// Root wraps the panel in an error boundary so a crash shows on the device
// instead of the window silently closing.
AppRegistry.registerComponent(appName, () => Root);

PluginManager.init();

// Deliberately NOT behind __DEV__. buildPlugin.sh always bundles with
// `--dev false`, so a gated log is invisible on any real install -- which makes
// a silent failure look identical to nothing having happened. This one line is
// how `adb logcat -s ReactNativeJS` confirms which build is actually running,
// and it catches the stale-reinstall trap (the host reinstalls from its own
// managed copy under MyStyle/Plugins/, not from what you pushed to MyStyle/).
console.log(`[LookUp] v${versionName} (code ${versionCode}) starting`);
startSession(`v${versionName} (code ${versionCode}) starting`);

// Errors outside a render pass — a rejected promise, a native callback — never
// reach the boundary, so they get logged here rather than disappearing.
const previousHandler = global.ErrorUtils?.getGlobalHandler?.();
global.ErrorUtils?.setGlobalHandler?.((err, isFatal) => {
  log(`uncaught${isFatal ? ' (fatal)' : ''}: ${err?.message}\n${err?.stack}`);
  previousHandler?.(err, isFatal);
});

const ICON = Image.resolveAssetSource(require('./assets/icon.png')).uri;

// Buttons are localised by passing a JSON string rather than a plain one; a
// plain string shows that literal text whatever the device language is set to.
const LABEL = JSON.stringify({
  en: 'Web Lookup',
  zh_CN: '网页查找',
  zh_TW: '網頁查找',
  ja: 'ウェブ検索',
});

/**
 * Toolbar button (type 1), NOTE and DOC.
 *
 * Opens the panel with nothing selected, so a search can be started by writing
 * one into the box. This is also the only entry point that does not require
 * setting up a selection first, which makes it the practical one for testing.
 */
PluginManager.registerButton(1, ['NOTE', 'DOC'], {
  id: 100,
  name: LABEL,
  icon: ICON,
  showType: 1,
});

/**
 * Lasso toolbar button (type 2), NOTE and DOC.
 *
 * editDataTypes is the 0-5 lasso index, NOT ElementType:
 *   0=stroke  1=title  2=picture  3=text  4=link  5=geometry
 * Only the three that can carry readable text are worth offering.
 */
PluginManager.registerButton(2, ['NOTE', 'DOC'], {
  id: 200,
  name: LABEL,
  icon: ICON,
  editDataTypes: [0, 1, 3],
  showType: 1,
});

/**
 * Text-selection toolbar button (type 3) — DOC only.
 *
 * Registering it for NOTE is harmless but the button never appears, so the
 * appTypes list is narrowed to say what is actually meant.
 */
PluginManager.registerButton(3, ['DOC'], {
  id: 300,
  name: LABEL,
  icon: ICON,
  showType: 1,
});

/**
 * Which button opened the panel, held at module scope.
 *
 * Every showType=1 button makes PluginHost open the plugin view, and the button
 * event can fire before App.tsx has mounted and registered its own listener.
 * Storing the id here first means the panel can still tell how it was opened,
 * rather than defaulting to the wrong entry point.
 */
let pendingButtonId = null;

/**
 * Notified when a button is pressed while the panel is already open.
 *
 * The panel is only mounted once: pressing the lasso button again does not
 * remount it, so without this a second lookup would leave the first one's
 * results on screen with no sign anything had happened.
 */
let subscriber = null;

PluginManager.registerButtonListener({
  onButtonPress(event) {
    const id = event?.id ?? null;
    pendingButtonId = id;
    log(`button ${id} pressed (pressEvent=${event?.pressEvent})`);
    if (subscriber) {
      // Consumed here rather than left pending: the panel is already listening,
      // and a leftover id would be picked up again by the next mount.
      pendingButtonId = null;
      subscriber(id);
    }
  },
});

/** Subscribe to presses that arrive while the panel is mounted. */
export const onButtonPress = callback => {
  subscriber = callback;
  return () => {
    if (subscriber === callback) {
      subscriber = null;
    }
  };
};

/** Read and clear the pending id. Call once, from App's mount effect. */
export const takePendingButton = () => {
  const id = pendingButtonId;
  pendingButtonId = null;
  return id;
};
