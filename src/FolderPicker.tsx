/* eslint-disable no-void -- void marks deliberately un-awaited promises in handlers */
/**
 * A folder browser over the device's shared storage.
 *
 * Walks one level at a time rather than drawing a tree: the panel is small, the
 * device holds thousands of folders, and a step-wise walk needs one native call
 * per screen. Ported from the same picker in Task Hub, which has been used on
 * this hardware long enough to have had its awkwardness found already.
 *
 * Drawn inside the panel rather than in a Modal. A second Android window costs
 * a full e-ink refresh to raise and another to dismiss, which reads as the
 * device hanging.
 */

import React, {useCallback, useEffect, useState} from 'react';
import {ScrollView, StyleSheet, Text, TouchableOpacity, View} from 'react-native';

import {listDirs} from './settings';

export function FolderPicker({
  visible,
  initialPath,
  onCancel,
  onPick,
}: {
  visible: boolean;
  /** Where the picker opens, relative to shared storage. */
  initialPath: string;
  onCancel: () => void;
  onPick: (relativePath: string) => void;
}): React.JSX.Element | null {
  const [path, setPath] = useState(initialPath);
  const [dirs, setDirs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (next: string) => {
    setBusy(true);
    try {
      setDirs(await listDirs(next));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      setPath(initialPath);
      void load(initialPath);
    }
  }, [visible, initialPath, load]);

  if (!visible) {
    return null;
  }

  const goTo = (next: string) => {
    setPath(next);
    void load(next);
  };

  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Choose a folder</Text>
      <Text style={styles.path}>{path ? `/${path}` : '/ (internal storage)'}</Text>

      <View style={styles.nav}>
        <TouchableOpacity style={styles.navBtn} onPress={() => goTo('')}>
          <Text style={styles.navText}>⌂ Root</Text>
        </TouchableOpacity>
        {path ? (
          <TouchableOpacity style={styles.navBtn} onPress={() => goTo(parent)}>
            <Text style={styles.navText}>↑ Up</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <ScrollView style={styles.list}>
        {busy ? <Text style={styles.empty}>Reading…</Text> : null}
        {!busy && dirs.length === 0 ? (
          <Text style={styles.empty}>No folders inside this one.</Text>
        ) : null}
        {dirs.map(name => (
          <TouchableOpacity
            key={name}
            style={styles.row}
            onPress={() => goTo(path ? `${path}/${name}` : name)}>
            <Text style={styles.rowText}>▸ {name}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <View style={styles.actions}>
        <TouchableOpacity style={[styles.navBtn, styles.primary]} onPress={() => onPick(path)}>
          <Text style={[styles.navText, styles.primaryText]}>Use this folder</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navBtn} onPress={onCancel}>
          <Text style={styles.navText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// Heavy borders and large rows, like the rest of the panel: this is greyscale
// e-ink read in reflected light, where a hairline simply is not there.
const styles = StyleSheet.create({
  card: {borderWidth: 2, borderColor: '#000', padding: 12, marginBottom: 8},
  title: {fontSize: 20, fontWeight: '700', color: '#000', marginBottom: 4},
  path: {fontSize: 16, color: '#000', marginBottom: 8},
  nav: {flexDirection: 'row', marginBottom: 8},
  navBtn: {
    borderWidth: 2,
    borderColor: '#000',
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginRight: 8,
  },
  navText: {fontSize: 17, color: '#000', fontWeight: '600'},
  primary: {backgroundColor: '#000'},
  primaryText: {color: '#fff'},
  list: {maxHeight: 260, borderWidth: 2, borderColor: '#000', marginBottom: 8},
  row: {paddingVertical: 12, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: '#000'},
  rowText: {fontSize: 18, color: '#000'},
  empty: {fontSize: 16, color: '#000', padding: 12},
  actions: {flexDirection: 'row'},
});
