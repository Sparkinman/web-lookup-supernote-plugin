/**
 * What PluginHost actually mounts.
 *
 * The panel is required lazily, from inside the boundary, rather than imported
 * at the top of this file. An import at module scope runs before any component
 * exists to catch it, so a failure there — a missing native module behind
 * react-native-webview being the obvious candidate — would take the whole
 * bundle down and leave nothing on screen. Requiring it during render puts
 * import-time failures inside the boundary's reach too.
 */

import React from 'react';

import {ErrorBoundary} from './ErrorBoundary';

function Panel(): React.JSX.Element {
  const App = require('../App').default;
  return <App />;
}

export default function Root(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <Panel />
    </ErrorBoundary>
  );
}
