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
import App from './App';
import {name as appName} from './app.json';

import {PluginManager} from 'sn-plugin-lib';

// MUST come before PluginManager.init() — init depends on the registered component.
AppRegistry.registerComponent(appName, () => App);

PluginManager.init();

// Deliberately NOT behind __DEV__. buildPlugin.sh always bundles with
// `--dev false`, so a gated log is invisible on any real install -- which makes
// a silent failure look identical to nothing having happened. This one line is
// how `adb logcat -s ReactNativeJS` confirms which build is actually running,
// and it catches the stale-reinstall trap (the host reinstalls from its own
// managed copy under MyStyle/Plugins/, not from what you pushed to MyStyle/).
console.log('[LookUp] starting');

const ICON = Image.resolveAssetSource(require('./assets/icon.png')).uri;

// Buttons are localised by passing a JSON string rather than a plain one; a
// plain string shows that literal text whatever the device language is set to.
const LABEL = JSON.stringify({
  en: 'Look up',
  zh_CN: '查找',
  zh_TW: '查找',
  ja: '検索',
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

PluginManager.registerButtonListener({
  onButtonPress(event) {
    pendingButtonId = event?.id ?? null;
    console.log(`[LookUp] button ${pendingButtonId} pressed`);
  },
});

/** Read and clear the pending id. Call once, from App's mount effect. */
export const takePendingButton = () => {
  const id = pendingButtonId;
  pendingButtonId = null;
  return id;
};
