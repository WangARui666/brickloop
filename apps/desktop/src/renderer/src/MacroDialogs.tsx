import { useEffect, useState } from 'react';
import { Alert, AutoComplete, Input, Modal, Segmented } from 'antd';
import { Box } from 'lucide-react';
import { macroName, writeMacro } from '@brickloop/io';
import { macroCategories, refreshMacros, useMacroStore } from './macro-store';
import { renderModelThumbnail } from './model-thumbnail';
import { useShellStore, useTranslation } from './store';

export function MacroDialogs() {
  const t = useTranslation(),
    { draft, rename, remove, entries } = useMacroStore();
  const [name, setName] = useState(''),
    [category, setCategory] = useState('');
  const [neutral, setNeutral] = useState(false),
    [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const language = useShellStore((state) => state.language);
  const categories = [...new Set([...macroCategories, ...entries.map((entry) => entry.meta.category)])];
  const label = (id: string) => t(`macro.categories.${id}`, { defaultValue: id });
  useEffect(() => {
    setName(draft ? macroName(draft.meta.name, language) : rename ? macroName(rename.meta.name, language) : '');
    setCategory(label('furniture'));
    setNeutral(false);
    setError(null);
  }, [draft, rename]);
  useEffect(() => {
    if (!draft) return;
    let active = true;
    setPreview('');
    setError(null);
    void renderModelThumbnail(draft.document, neutral, () => active)
      .then((png) => {
        if (active) setPreview(png);
      })
      .catch(() => {
        if (active) setError(t('macroUi.previewFailed'));
      });
    return () => {
      active = false;
    };
  }, [draft, neutral]);
  async function save() {
    if (!draft || !preview || !name.trim() || !category.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const thumbnail = Uint8Array.from(atob(preview.split(',')[1]!), (char) => char.charCodeAt(0));
      const id = categories.find((id) => label(id) === category.trim()) ?? category.trim();
      const entry = await window.brickloop.macroSave(
        writeMacro({ ...draft, thumbnail, meta: { ...draft.meta, name: name.trim(), category: id } }),
      );
      await refreshMacros();
      useMacroStore.setState({ draft: null, category: id, query: '', selected: entry.id });
      useShellStore.setState({ leftTab: 'macros', leftCollapsed: false });
    } catch {
      setError(t('macroUi.saveFailed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Modal
        open={!!draft}
        width={480}
        title={t('desktop.commands.macro.saveSelection.label')}
        onCancel={() => {
          if (!busy) useMacroStore.setState({ draft: null });
        }}
        onOk={() => void save()}
        okText={t('macroUi.save')}
        cancelText={t('files.cancel')}
        confirmLoading={busy}
        okButtonProps={{ disabled: !preview || !name.trim() || !category.trim() }}
      >
        <div className="macro-save-layout">
          <div className="macro-live-preview" aria-label={t('macroUi.preview')}>
            {preview ? (
              <img src={preview} width={128} height={128} alt={t('macroUi.preview')} />
            ) : error ? (
              <Box />
            ) : (
              <span className="thumbnail-skeleton" />
            )}
          </div>
          <div className="macro-fields">
            <label>
              {t('macroUi.name')}
              <Input
                aria-label={t('macroUi.name')}
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              {t('macroUi.category')}
              <AutoComplete
                aria-label={t('macroUi.category')}
                value={category}
                maxLength={80}
                options={categories.map((id) => ({ value: label(id) }))}
                filterOption={(input, option) =>
                  typeof option?.value === 'string' && option.value.toLowerCase().includes(input.toLowerCase())
                }
                onChange={setCategory}
                placeholder={t('macroUi.newCategory')}
              />
            </label>
          </div>
        </div>
        <div className="macro-style">
          <span>{t('macroUi.thumbnailStyle')}</span>
          <Segmented
            value={neutral ? 'neutral' : 'original'}
            onChange={(value) => setNeutral(value === 'neutral')}
            options={[
              { value: 'original', label: t('macroUi.original') },
              { value: 'neutral', label: t('macroUi.neutral') },
            ]}
          />
        </div>
        {error && <Alert type="error" title={error} />}
      </Modal>
      <Modal
        open={!!rename}
        width={480}
        title={t('macroUi.rename')}
        confirmLoading={busy}
        okText={t('files.confirm')}
        cancelText={t('files.cancel')}
        okButtonProps={{ disabled: !name.trim() }}
        onCancel={() => useMacroStore.setState({ rename: null })}
        onOk={() => {
          if (!rename) return;
          setBusy(true);
          void window.brickloop
            .macroRename(rename.id, name.trim())
            .then(async () => {
              await refreshMacros();
              useMacroStore.setState({ rename: null });
            })
            .catch(() => setError(t('macroUi.saveFailed')))
            .finally(() => setBusy(false));
        }}
      >
        <Input
          aria-label={t('macroUi.name')}
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
        />
        {error && <Alert type="error" title={error} />}
      </Modal>
      <Modal
        open={!!remove}
        width={480}
        title={t('macroUi.delete')}
        confirmLoading={busy}
        okText={t('macroUi.delete')}
        cancelText={t('files.cancel')}
        okButtonProps={{ danger: true }}
        onCancel={() => useMacroStore.setState({ remove: null })}
        onOk={() => {
          if (!remove) return;
          setBusy(true);
          void window.brickloop
            .macroRemove(remove.id)
            .then(async () => {
              await refreshMacros();
              useMacroStore.setState({ remove: null });
            })
            .catch(() => setError(t('macroUi.deleteFailed')))
            .finally(() => setBusy(false));
        }}
      >
        <p>{t('macroUi.confirmDelete', { name: remove ? macroName(remove.meta.name, language) : '' })}</p>
        {error && <Alert type="error" title={error} />}
      </Modal>
    </>
  );
}
