/**
 * Shows a crash instead of vanishing.
 *
 * An uncaught render error inside PluginHost tears the plugin view down, which
 * from the outside looks exactly like the window opening and closing again —
 * no message, nothing on screen, and nothing to go on unless a cable happens to
 * be plugged in. Catching it here puts the error where it can actually be read:
 * on the device, in the panel that just failed.
 */

import React from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';

import {log} from './log';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  stack: string | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = {error: null, stack: null};

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {error};
  }

  componentDidCatch(error: Error, info: {componentStack?: string | null}) {
    log(`crash: ${error?.message}\n${info?.componentStack ?? ''}`);
    this.setState({stack: info?.componentStack ?? null});
  }

  render() {
    const {error, stack} = this.state;
    if (!error) {
      return this.props.children;
    }
    return (
      <View style={styles.root}>
        <Text style={styles.title}>Look Up hit an error</Text>
        <ScrollView style={styles.scroll}>
          <Text style={styles.message}>{String(error?.message ?? error)}</Text>
          {stack ? <Text style={styles.stack}>{stack}</Text> : null}
        </ScrollView>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#fff', padding: 16},
  title: {fontSize: 18, fontWeight: '700', color: '#000', marginBottom: 10},
  scroll: {flex: 1},
  message: {fontSize: 14, color: '#000', marginBottom: 12},
  stack: {fontSize: 11, color: '#000'},
});
