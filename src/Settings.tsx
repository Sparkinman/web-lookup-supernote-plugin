/**
 * The settings screen.
 *
 * A screen of its own rather than a panel above the reader. An earlier version
 * drew the settings inline at the top of the panel, where they sat on top of
 * every search that followed, took half the display and could not be dismissed.
 *
 * The shape is Task Hub's: collapsible groups so the whole of it is not thrown
 * at somebody at once, a labelled field beside a Browse button for anything
 * that names a place on the device, and a help section that explains what the
 * plugin does rather than assuming it is obvious.
 */

import React, {useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View} from 'react-native';

import {FolderPicker} from './FolderPicker';
import {
  BOOK_QUERY_CHOICES,
  DEFAULT_SETTINGS,
  MAX_LABEL_LENGTH,
  type Settings,
} from './settings';

/** Where shared storage is mounted, which the browser speaks in terms of. */
const STORAGE_ROOT = '/storage/emulated/0';

const relativeOf = (path: string): string =>
  (path.startsWith(STORAGE_ROOT) ? path.slice(STORAGE_ROOT.length) : path)
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');

const folderOf = (path: string): string => {
  const cut = path.lastIndexOf('/');
  return cut > 0 ? path.slice(0, cut) : path;
};

const nameOf = (path: string): string =>
  path.slice(path.lastIndexOf('/') + 1) || 'Look Up.note';

/**
 * A folder, drawn rather than typed.
 *
 * The device's font has no folder glyph and Android renders a missing one as a
 * box with a cross through it, so the icon is built out of plain Views, which
 * always draw. Taken from Task Hub, where the same thing was discovered.
 */
function FolderIcon({size = 24}: {size?: number}): React.JSX.Element {
  const tab = Math.round(size * 0.22);
  return (
    <View style={[styles.folderIcon, {width: size, height: size}]}>
      <View style={[styles.folderTab, {width: Math.round(size * 0.45), height: tab}]} />
      <View style={[styles.folderBody, {width: size, height: size - tab}]} />
    </View>
  );
}

function Fold({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={styles.fold}>
      <TouchableOpacity style={styles.foldHead} onPress={onToggle}>
        <Text style={styles.foldTitle}>
          {open ? '▾' : '▸'} {title}
        </Text>
      </TouchableOpacity>
      {open ? <View style={styles.foldBody}>{children}</View> : null}
    </View>
  );
}

function Check({
  on,
  label,
  hint,
  onPress,
}: {
  on: boolean;
  label: string;
  hint: string;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <TouchableOpacity style={[styles.choice, on && styles.choiceOn]} onPress={onPress}>
      <Text style={[styles.choiceLabel, on && styles.onText]}>
        {on ? '☑ ' : '☐ '}
        {label}
      </Text>
      <Text style={[styles.choiceHint, on && styles.onText]}>{hint}</Text>
    </TouchableOpacity>
  );
}

/** A named place on the device: the path, and a Browse button beside it. */
function PathField({
  label,
  hint,
  value,
  onChange,
  onBrowse,
  browsing,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (next: string) => void;
  onBrowse: () => void;
  browsing: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.fieldRow}>
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={onChange}
          autoCorrect={false}
        />
        <TouchableOpacity style={styles.browse} onPress={onBrowse}>
          <FolderIcon />
          <Text style={styles.browseLabel}>{browsing ? 'Close' : 'Browse'}</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.choiceHint}>{hint}</Text>
    </View>
  );
}

export function SettingsScreen({
  settings,
  onChange,
  onDone,
  onClose,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onDone: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState<string>('keep');
  const [picking, setPicking] = useState<'clips' | 'digest' | null>(null);
  const fold = (key: string) => setOpen(current => (current === key ? '' : key));

  return (
    <View style={styles.root}>
      <View style={styles.bar}>
        <Text style={styles.title}>Web Lookup — Settings</Text>
        <View style={styles.spacer} />
        <TouchableOpacity style={styles.btn} onPress={onDone}>
          <Text style={styles.btnText}>Done</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.btn} onPress={onClose}>
          <Text style={styles.btnText}>Close</Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyInner}>
        <Fold title="What a lookup leaves behind" open={open === 'keep'} onToggle={() => fold('keep')}>
          <Check
            on={settings.savePicture}
            label="A picture of what you kept"
            hint="Drawn from the passages you chose and linked, so it survives the page changing"
            onPress={() => onChange({savePicture: !settings.savePicture})}
          />
          <Check
            on={settings.sourceLink}
            label="A link to the page on the web"
            hint="Stays current, and can rot — turn it off to keep the note offline"
            onPress={() => onChange({sourceLink: !settings.sourceLink})}
          />
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>What that picture's link is called</Text>
            <TextInput
              style={styles.input}
              value={settings.notesLabel}
              onChangeText={value => onChange({notesLabel: value})}
              maxLength={MAX_LABEL_LENGTH}
              placeholder={DEFAULT_SETTINGS.notesLabel}
              autoCorrect={false}
            />
            <Text style={styles.choiceHint}>
              The words written under your handwriting that open what you kept.
            </Text>
          </View>
        </Fold>

        <Fold title="Reading a book" open={open === 'book'} onToggle={() => fold('book')}>
          {BOOK_QUERY_CHOICES.map(choice => (
            <TouchableOpacity
              key={choice.value}
              style={[styles.choice, settings.bookQuery === choice.value && styles.choiceOn]}
              onPress={() => onChange({bookQuery: choice.value})}>
              <Text
                style={[
                  styles.choiceLabel,
                  settings.bookQuery === choice.value && styles.onText,
                ]}>
                {settings.bookQuery === choice.value ? '● ' : '○ '}
                {choice.label}
              </Text>
              <Text
                style={[styles.choiceHint, settings.bookQuery === choice.value && styles.onText]}>
                {choice.hint}
              </Text>
            </TouchableOpacity>
          ))}
        </Fold>

        <Fold title="Where things are saved" open={open === 'places'} onToggle={() => fold('places')}>
          <PathField
            label="Clippings and screenshots"
            hint="A folder on the device. Relative names sit inside internal storage."
            value={settings.clipFolder}
            onChange={value => onChange({clipFolder: value})}
            browsing={picking === 'clips'}
            onBrowse={() => setPicking(picking === 'clips' ? null : 'clips')}
          />
          <FolderPicker
            visible={picking === 'clips'}
            initialPath={relativeOf(settings.clipFolder)}
            onCancel={() => setPicking(null)}
            onPick={chosen => {
              onChange({clipFolder: chosen});
              setPicking(null);
            }}
          />

          <PathField
            label="Excerpts taken from a book"
            hint="One page per excerpt, each with a link back to the page of the book."
            value={settings.digestNote}
            onChange={value => onChange({digestNote: value})}
            browsing={picking === 'digest'}
            onBrowse={() => setPicking(picking === 'digest' ? null : 'digest')}
          />
          <FolderPicker
            visible={picking === 'digest'}
            initialPath={relativeOf(folderOf(settings.digestNote))}
            onCancel={() => setPicking(null)}
            onPick={chosen => {
              // The browser picks a folder; the note keeps the name it has.
              onChange({
                digestNote: `${STORAGE_ROOT}/${chosen}/${nameOf(settings.digestNote)}`,
              });
              setPicking(null);
            }}
          />
        </Fold>

        <Fold title="How this works" open={open === 'help'} onToggle={() => fold('help')}>
          <Text style={styles.help}>
            Lasso handwriting on a note page, or select text in a book, and tap Web Lookup. What
            you selected becomes a search. Results are fetched and shown as plain text — there is
            no browser here, because Android will not create one inside a plugin.
          </Text>
          <Text style={styles.help}>
            Tap passages to choose them. The arrow at the right of a result opens that page
            instead.
          </Text>
          <Text style={styles.help}>
            In a note: "Paste selected text" writes the passages onto the page, and "Insert links"
            hangs links under your handwriting — one per page you chose, plus one to the picture
            of what you kept.
          </Text>
          <Text style={styles.help}>
            In a book: nothing can be written into the book itself. The firmware refuses every
            write into an open document, whichever API is asked, so excerpts are collected into
            the note named above instead.
          </Text>
        </Fold>
      </ScrollView>
    </View>
  );
}

// Heavy borders, large type: greyscale e-ink read in reflected light, where a
// hairline or a mid-grey is simply not there.
const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#fff'},
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    borderBottomWidth: 2,
    borderBottomColor: '#000',
  },
  title: {fontSize: 20, fontWeight: '700', color: '#000'},
  spacer: {flex: 1},
  btn: {paddingHorizontal: 14, paddingVertical: 10},
  btnText: {fontSize: 18, color: '#000', fontWeight: '600'},
  body: {flex: 1},
  bodyInner: {padding: 12, paddingBottom: 40},

  fold: {borderWidth: 2, borderColor: '#000', marginBottom: 10},
  foldHead: {paddingVertical: 14, paddingHorizontal: 12},
  foldTitle: {fontSize: 20, fontWeight: '700', color: '#000'},
  foldBody: {paddingHorizontal: 12, paddingBottom: 12},

  choice: {borderWidth: 2, borderColor: '#000', padding: 12, marginBottom: 8},
  choiceOn: {backgroundColor: '#000'},
  choiceLabel: {fontSize: 19, fontWeight: '600', color: '#000'},
  choiceHint: {fontSize: 16, color: '#000', marginTop: 4},
  onText: {color: '#fff'},

  field: {marginBottom: 12},
  fieldLabel: {fontSize: 17, fontWeight: '600', color: '#000', marginBottom: 6},
  fieldRow: {flexDirection: 'row', alignItems: 'stretch'},
  input: {
    flex: 1,
    borderWidth: 2,
    borderColor: '#000',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 18,
    color: '#000',
  },
  browse: {
    borderWidth: 2,
    borderColor: '#000',
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginLeft: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  browseLabel: {fontSize: 14, color: '#000', marginTop: 2},
  folderIcon: {justifyContent: 'flex-end'},
  folderTab: {backgroundColor: '#000', borderTopLeftRadius: 2, borderTopRightRadius: 2},
  folderBody: {backgroundColor: '#000', borderRadius: 2},

  help: {fontSize: 17, color: '#000', marginBottom: 10, lineHeight: 24},
});
