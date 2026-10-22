/** The only keyboard binding definitions. UI labels live in i18n, never key assignments. */
export const defaultShortcuts: Readonly<Record<string, readonly string[]>> = {
  'file.new': ['Ctrl+N'],
  'file.open': ['Ctrl+O'],
  'file.save': ['Ctrl+S'],
  'file.saveAs': ['Ctrl+Shift+S'],
  'file.close': ['Ctrl+W'],
  'file.next': ['Ctrl+Tab'],
  'file.import': ['Ctrl+I'],
  'file.export': ['Ctrl+E'],
  'file.pdf': [],
  'edit.undo': ['Ctrl+Z'],
  'edit.redo': ['Ctrl+Shift+Z', 'Ctrl+Y'],
  'edit.copy': ['Ctrl+C'],
  'edit.cut': ['Ctrl+X'],
  'edit.paste': ['Ctrl+V'],
  'edit.delete': ['Delete'],
  'edit.clone': ['C'],
  'structure.rename': ['F2'],
  'select.all': ['Ctrl+A'],
  'select.clear': [],
  'select.invert': [],
  'select.sameColor': [],
  'select.sameType': [],
  'select.sameColorAndType': [],
  'select.connected': [],
  'editor.escape': ['Escape'],
  'view.steps': ['Ctrl+Shift+P'],
  'view.hide': ['H'],
  'view.showOnly': ['Shift+H'],
  'view.showAll': ['Alt+H'],
  'view.fitAll': ['Ctrl+0'],
  'view.fitSelection': ['F'],
  'view.front': ['Numpad1'],
  'view.back': ['Ctrl+Numpad1'],
  'view.right': ['Numpad3'],
  'view.left': ['Ctrl+Numpad3'],
  'view.top': ['Numpad7'],
  'view.bottom': ['Ctrl+Numpad7'],
  'view.iso': [],
  'view.screenshot': [],
  'tool.select': [],
  'tool.move': [],
  'tool.rotate': [],
  'tool.eyedropper': ['I'],
  'tool.grid1': ['1'],
  'tool.grid2': ['2'],
  'tool.grid3': ['3'],
  'tool.snap.toggle': [],
  'tool.collision.toggle': [],
  'check.run': ['F7'],
  'ai.open': ['Ctrl+K'],
  'move.forward': ['W'],
  'move.back': ['S'],
  'move.left': ['A'],
  'move.right': ['D'],
  'move.up': ['Q'],
  'move.down': ['E'],
  'rotate.left': ['ArrowLeft'],
  'rotate.right': ['ArrowRight'],
  'rotate.up': ['ArrowUp'],
  'rotate.down': ['ArrowDown'],
  'rotate.leftFine': ['Shift+ArrowLeft'],
  'rotate.rightFine': ['Shift+ArrowRight'],
  'rotate.upFine': ['Shift+ArrowUp'],
  'rotate.downFine': ['Shift+ArrowDown'],
  'transform.snapToGrid': ['Ctrl+Shift+A'],
  'group.create': ['Ctrl+G'],
  'group.dissolve': ['Ctrl+Shift+G'],
  'group.enter': [],
  'group.exit': [],
  'submodel.create': ['Ctrl+Alt+G'],
  'submodel.instantiate': [],
  'submodel.makeUnique': [],
  'submodel.explode': [],
  'submodel.independent': [],
  'submodel.enter': [],
  'submodel.exit': [],
  'step.add': [],
  'step.remove': [],
  'step.move': [],
  'step.assign': [],
  'macro.insert': [],
  'macro.saveSelection': [],
  'model.info': [],
  'settings.open': ['Ctrl+,'],
};
export type ShortcutBindings = Record<string, string[]>;
export function effectiveShortcuts(overrides: ShortcutBindings = {}): ShortcutBindings {
  return Object.fromEntries(Object.entries(defaultShortcuts).map(([id, keys]) => [id, [...(overrides[id] ?? keys)]]));
}
const keyPattern =
  /^(?:(?:Ctrl|Alt|Shift)\+)*(?:[A-Z0-9,.;/[\]\\'\-=`]|F(?:[1-9]|1[0-9]|2[0-4])|Numpad[0-9]|Arrow(?:Left|Right|Up|Down)|Escape|Tab|Space|Enter|Backspace|Delete|Home|End|PageUp|PageDown)$/;
export function normalizeShortcut(value: string): string {
  const parts = value.split('+'),
    key = parts.pop()!;
  const canonical = [...['Ctrl', 'Alt', 'Shift'].filter((mod) => parts.includes(mod)), key].join('+');
  if (!keyPattern.test(value) || canonical !== value) throw new TypeError('Invalid shortcut');
  return canonical;
}
export function shortcutFromEvent(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
): string | null {
  let key = /^Numpad\d$/.test(event.code) ? event.code : event.key;
  if (/^Digit\d$/.test(event.code)) key = event.code.slice(5);
  if (key === ' ') key = 'Space';
  if (key.length === 1) key = key.toUpperCase();
  const value = [
    event.ctrlKey || event.metaKey ? 'Ctrl' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
    key,
  ]
    .filter(Boolean)
    .join('+');
  try {
    return normalizeShortcut(value);
  } catch {
    return null;
  }
}
export function shortcutConflicts(bindings: ShortcutBindings): { key: string; commands: string[] }[] {
  const owners = new Map<string, string[]>();
  for (const [id, keys] of Object.entries(bindings))
    for (const key of keys) owners.set(key, [...(owners.get(key) ?? []), id]);
  return [...owners].filter(([, ids]) => ids.length > 1).map(([key, commands]) => ({ key, commands }));
}
export function parseShortcuts(value: unknown, allowConflicts = false): ShortcutBindings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid shortcuts');
  const result: ShortcutBindings = {};
  for (const [id, keys] of Object.entries(value)) {
    if (
      !Object.hasOwn(defaultShortcuts, id) ||
      !Array.isArray(keys) ||
      keys.length > 4 ||
      !keys.every((key): key is string => typeof key === 'string')
    )
      throw new TypeError('Invalid shortcuts');
    result[id] = [...new Set(keys.map(normalizeShortcut))];
  }
  const effective = effectiveShortcuts(result);
  if (!allowConflicts && shortcutConflicts(effective).length) throw new TypeError('Conflicting shortcuts');
  return effective;
}
export function exportShortcuts(bindings: ShortcutBindings): string {
  return JSON.stringify({ version: 1, bindings: parseShortcuts(bindings) }, null, 2) + '\n';
}
export function importShortcuts(text: string): ShortcutBindings {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('bindings' in value))
    throw new TypeError('Invalid shortcuts file');
  return parseShortcuts(value.bindings, true);
}
export function assignShortcut(bindings: ShortcutBindings, command: string, key: string): ShortcutBindings {
  const next = effectiveShortcuts(bindings);
  for (const id of Object.keys(next)) next[id] = next[id]!.filter((binding) => binding !== key);
  next[command] = [normalizeShortcut(key)];
  return next;
}
