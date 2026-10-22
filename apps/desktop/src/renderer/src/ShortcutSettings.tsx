import { useState } from 'react';
import { Alert, Button, Input, Modal } from 'antd';
import { Keyboard, Search } from 'lucide-react';
import {
  assignShortcut,
  defaultShortcuts,
  effectiveShortcuts,
  exportShortcuts,
  importShortcuts,
  shortcutConflicts,
  shortcutFromEvent,
} from '../../shared/shortcuts';
import type { ShortcutBindings } from '../../shared/shortcuts';
import { commandLabel, savePreferences, usePreferences } from './preferences-store';
import { useTranslation } from './store';

export function ShortcutSettings() {
  const t = useTranslation(),
    bindings = usePreferences((s) => s.value.shortcuts);
  const [query, setQuery] = useState(''),
    [recording, setRecording] = useState<string | null>(null);
  const [pending, setPending] = useState<{ bindings: ShortcutBindings; description: string } | null>(null);
  const [error, setError] = useState(false);
  const visibleCommands = Object.keys(defaultShortcuts).filter((id) =>
    `${commandLabel(id)} ${bindings[id]?.join(' ')}`.toLowerCase().includes(query.toLowerCase()),
  );
  async function importFile() {
    try {
      const text = await window.brickloop.shortcutsImport();
      if (!text) return;
      const next = importShortcuts(text),
        conflicts = shortcutConflicts(next);
      if (conflicts.length) {
        const resolved = { ...next };
        for (const conflict of conflicts)
          for (const command of conflict.commands.slice(0, -1))
            resolved[command] = resolved[command]!.filter((key) => key !== conflict.key);
        setPending({
          bindings: resolved,
          description: conflicts.map((c) => `${c.key} · ${c.commands.map(commandLabel).join(' / ')}`).join('\n'),
        });
      } else await savePreferences({ shortcuts: next });
    } catch {
      setError(true);
    }
  }
  return (
    <div className="shortcut-settings">
      <Input
        prefix={<Search />}
        allowClear
        aria-label={t('preferences.searchKeys')}
        placeholder={t('preferences.searchKeys')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="settings-actions">
        <Button onClick={() => void savePreferences({ shortcuts: effectiveShortcuts() })}>
          {t('preferences.resetKeys')}
        </Button>
        <Button onClick={() => void importFile()}>{t('preferences.importKeys')}</Button>
        <Button
          onClick={() => void window.brickloop.shortcutsExport(exportShortcuts(bindings)).catch(() => setError(true))}
        >
          {t('preferences.exportKeys')}
        </Button>
      </div>
      {error && <Alert type="error" title={t('preferences.invalidKeys')} closable onClose={() => setError(false)} />}
      <div className="shortcut-list">
        {!visibleCommands.length && (
          <div className="settings-empty">
            <Search />
            <span>{t('preferences.noCommands')}</span>
          </div>
        )}
        {[...new Set(Object.keys(defaultShortcuts).map((id) => id.split('.')[0]!))].map((group) => {
          const commands = visibleCommands.filter((id) => id.startsWith(`${group}.`));
          return commands.length ? (
            <section key={group}>
              <h3>{t(`preferences.groups.${group}`)}</h3>
              {commands.map((id) => (
                <div className="shortcut-row" key={id}>
                  <span>{commandLabel(id)}</span>
                  <Button
                    aria-label={t('preferences.recordKey', { command: commandLabel(id) })}
                    onClick={() => setRecording(id)}
                  >
                    {bindings[id]?.join(' / ') || t('preferences.unassigned')}
                  </Button>
                </div>
              ))}
            </section>
          ) : null;
        })}
      </div>
      <Modal
        open={!!recording}
        title={t('preferences.recordTitle')}
        width={480}
        onCancel={() => setRecording(null)}
        footer={<Button onClick={() => setRecording(null)}>{t('files.cancel')}</Button>}
      >
        <div
          className="key-recorder"
          tabIndex={0}
          ref={(node) => node?.focus()}
          role="textbox"
          aria-label={t('preferences.pressKeys')}
          onKeyDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!recording) return;
            const key = shortcutFromEvent(event.nativeEvent);
            if (!key) return;
            const owners = Object.entries(bindings)
              .filter(([id, keys]) => id !== recording && keys.includes(key))
              .map(([id]) => id);
            const next = assignShortcut(bindings, recording, key);
            if (owners.length)
              setPending({
                bindings: next,
                description: t('preferences.keyConflict', {
                  key,
                  commands: owners.map(commandLabel).join('、'),
                  target: commandLabel(recording),
                }),
              });
            else void savePreferences({ shortcuts: next });
            setRecording(null);
          }}
        >
          <Keyboard />
          <span>{t('preferences.pressKeys')}</span>
        </div>
      </Modal>
      <Modal
        open={!!pending}
        title={t('preferences.conflictTitle')}
        width={480}
        okText={t('preferences.overwrite')}
        cancelText={t('files.cancel')}
        onCancel={() => setPending(null)}
        onOk={() => {
          if (pending) void savePreferences({ shortcuts: pending.bindings });
          setPending(null);
        }}
      >
        <p className="preserve-lines">{pending?.description}</p>
        <p className="secondary">{t('preferences.overwriteHint')}</p>
      </Modal>
    </div>
  );
}
