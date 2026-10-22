import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, InputNumber, Select } from 'antd';
import { FolderOpen } from 'lucide-react';
import type { StorageInfo } from '../../shared/release-api';
import { useShellStore, useTranslation } from './store';
import { usePreferences, savePreferences } from './preferences-store';
import { useLibraryStore } from './library-store';
import { setMaintenance, useAssemblyStore } from './assembly-store';
import { ShortcutSettings } from './ShortcutSettings';
import type { ReactNode } from 'react';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="settings-row">
      <span>{label}</span>
      {children}
    </label>
  );
}
function LibrarySettings() {
  const t = useTranslation(),
    [storage, setStorage] = useState<StorageInfo | null>(null),
    [error, setError] = useState(false),
    [busy, setBusy] = useState(false);
  const pack = useLibraryStore((s) => s.status?.pack),
    value = usePreferences((s) => s.value);
  useEffect(() => {
    void window.brickloop
      .storageInfo()
      .then(setStorage)
      .catch(() => setError(true));
  }, [value.libraryPath]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(false);
    try {
      await action();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-page">
      {error && <Alert type="error" title={t('libraryUi.operationFailed')} />}
      <h3>{t('preferences.libraryPath')}</h3>
      <p className="settings-path">{value.libraryPath || storage?.library || '—'}</p>
      <Button
        icon={<FolderOpen />}
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const path = await window.brickloop.libraryChoose();
            if (path) await savePreferences({ libraryPath: path });
          })
        }
      >
        {t('preferences.chooseLibrary')}
      </Button>
      <h3>{t('preferences.enabledPacks')}</h3>
      <p>{pack?.name ?? t('libraryUi.unavailable')}</p>
      <Button onClick={() => useLibraryStore.getState().openManager(true)}>{t('libraryUi.manage')}</Button>
      <h3>{t('preferences.cache')}</h3>
      <p className="settings-path">{storage?.cache ?? '—'}</p>
      <div className="settings-actions">
        <span>{t('preferences.cacheSize', { size: ((storage?.bytes ?? 0) / 1048576).toFixed(1) })}</span>
        <Button loading={busy} onClick={() => void run(async () => setStorage(await window.brickloop.cacheClear()))}>
          {t('preferences.clearCache')}
        </Button>
      </div>
      {storage?.migrationFallback && <Alert type="warning" title={t('preferences.migrationFallback')} />}
    </div>
  );
}
export function useSettingsPages() {
  const t = useTranslation(),
    { value, error } = usePreferences(),
    language = useShellStore((s) => s.language),
    maintenance = useAssemblyStore((s) => s.maintenance);
  const save = savePreferences;
  return [
    {
      key: 'general',
      label: t('preferences.general'),
      children: (
        <div className="settings-page">
          {error && <Alert type="error" title={t('desktop.errors.save')} />}
          <Row label={t('desktop.language')}>
            <Select
              aria-label={t('desktop.language')}
              value={language}
              onChange={(v) => void useShellStore.getState().setLanguage(v)}
              options={['zh-CN', 'en'].map((value) => ({ value, label: t(`language.${value}`) }))}
            />
          </Row>
          <Row label={t('preferences.unit')}>
            <Select
              aria-label={t('preferences.unit')}
              value={value.unit}
              onChange={(unit) => void save({ unit })}
              options={['stud', 'mm', 'cm', 'ldu'].map((value) => ({ value, label: t(`editor.units.${value}`) }))}
            />
          </Row>
          <Row label={t('preferences.snapshot')}>
            <InputNumber
              aria-label={t('preferences.snapshot')}
              min={1}
              max={60}
              value={value.snapshotMinutes}
              onChange={(v) => {
                if (v) void save({ snapshotMinutes: v });
              }}
              suffix={t('preferences.minutes')}
            />
          </Row>
          <Checkbox checked={value.reopenLast} onChange={(e) => void save({ reopenLast: e.target.checked })}>
            {t('preferences.reopenLast')}
          </Checkbox>
          <p className="secondary">{t('preferences.instant')}</p>
        </div>
      ),
    },
    {
      key: 'editing',
      label: t('preferences.editing'),
      children: (
        <div className="settings-page">
          <Row label={t('preferences.grid')}>
            <Select
              aria-label={t('preferences.grid')}
              value={value.grid}
              onChange={(grid) => void save({ grid })}
              options={[20, 10, 5].map((value) => ({ value, label: t(`desktop.viewport.gridSteps.${value}`) }))}
            />
          </Row>
          <Row label={t('preferences.angle')}>
            <Select
              aria-label={t('preferences.angle')}
              value={value.angle}
              onChange={(angle) => void save({ angle })}
              options={[90, 45, 22.5, 15, 5, 1].map((value) => ({ value, label: `${value}°` }))}
            />
          </Row>
          <Row label={t('connectUi.policy')}>
            <Select
              aria-label={t('connectUi.policy')}
              value={value.collisionPolicy}
              onChange={(collisionPolicy) => void save({ collisionPolicy })}
              options={['warn', 'block'].map((value) => ({ value, label: t(`connectUi.policies.${value}`) }))}
            />
          </Row>
          <Row label={t('performance.edges')}>
            <Select
              aria-label={t('performance.edges')}
              value={value.edgeMode}
              onChange={(edgeMode) => void save({ edgeMode })}
              options={['auto', 'always'].map((value) => ({ value, label: t(`performance.edges_${value}`) }))}
            />
          </Row>
          <Checkbox checked={value.snap} onChange={(e) => void save({ snap: e.target.checked })}>
            {t('preferences.snap')}
          </Checkbox>
          <Checkbox checked={value.mergeKeyboard} onChange={(e) => void save({ mergeKeyboard: e.target.checked })}>
            {t('preferences.mergeKeyboard')}
          </Checkbox>
        </div>
      ),
    },
    { key: 'shortcuts', label: t('preferences.shortcuts'), children: <ShortcutSettings /> },
    { key: 'library', label: t('preferences.library'), children: <LibrarySettings /> },
    {
      key: 'advanced',
      label: t('preferences.advanced'),
      children: (
        <div className="settings-page">
          <Checkbox checked={value.logging} onChange={(e) => void save({ logging: e.target.checked })}>
            {t('preferences.logging')}
          </Checkbox>
          <Checkbox checked={value.developerMode} onChange={(e) => void save({ developerMode: e.target.checked })}>
            {t('preferences.developerMode')}
          </Checkbox>
          <Checkbox checked={maintenance} onChange={(e) => void setMaintenance(e.target.checked)}>
            {t('annotation.maintenance')}
          </Checkbox>
          <p className="secondary">{t('preferences.maintenanceHint')}</p>
        </div>
      ),
    },
  ];
}
