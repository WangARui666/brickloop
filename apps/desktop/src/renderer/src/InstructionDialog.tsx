import { AnimationButton } from './BuildAnimationDialog';
import { useRef, useState } from 'react';
import { Alert, Button, Checkbox, Modal, Progress, Select } from 'antd';
import { planInstructions } from '@brickloop/instructions';
import type { InstructionOptions } from '@brickloop/instructions';
import { usePreferences } from './preferences-store';
import { useShellStore, useTranslation } from './store';
import { documentSession } from './document-store';
import { useLibraryStore } from './library-store';
import { createInstructionHost, renderInstructionWorker } from './instruction-host';

export function InstructionDialog() {
  const t = useTranslation(),
    open = usePreferences((s) => s.pdf),
    language = useShellStore((s) => s.language);
  const [options, setOptions] = useState<
    InstructionOptions &
      Required<Pick<InstructionOptions, 'paper' | 'stepsPerPage' | 'includeCover' | 'includeBom' | 'dpi'>>
  >({ paper: 'A4-landscape', stepsPerPage: 4, includeCover: true, includeBom: true, dpi: 150 });
  const [highlight, setHighlight] = useState(true),
    [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState({ completedPages: 0, totalPages: 0 });
  const [error, setError] = useState(false),
    [notice, setNotice] = useState(''),
    [issues, setIssues] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const patch = (value: InstructionOptions) => setOptions((old) => ({ ...old, ...value }));
  async function submit() {
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError(false);
    setNotice('');
    setIssues(0);
    setProgress({ completedPages: 0, totalPages: 0 });
    try {
      const doc = structuredClone(documentSession.document);
      const resources = await window.brickloop.instructionResources();
      controller.signal.throwIfAborted();
      const plan = planInstructions(doc, {
        ...options,
        rootModelId: options.rootModelId && doc.models[options.rootModelId] ? options.rootModelId : doc.rootModelId,
        language: options.language ?? language,
        catalog: resources.catalog,
        metadataDate: new Date().toISOString(),
      });
      setIssues(plan.bom.issues.length);
      const host = createInstructionHost(
        doc,
        plan,
        [...(resources.catalog.colors ?? [])],
        useLibraryStore.getState().status?.pack?.id ?? 'demo',
        controller.signal,
        highlight,
      );
      const bytes = await renderInstructionWorker(plan, {
        ...host,
        fonts: resources,
        signal: controller.signal,
        onProgress: setProgress,
      });
      controller.signal.throwIfAborted();
      setSaving(true);
      const file = await window.brickloop.instructionSave(bytes, doc.meta.title);
      setNotice(file ? t('instructionsUi.saved', { path: file }) : t('instructionsUi.canceled'));
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError'))
        setNotice(t('instructionsUi.canceled'));
      else setError(true);
    } finally {
      setBusy(false);
      setSaving(false);
      abort.current = null;
    }
  }
  return (
    <Modal
      open={open}
      width={640}
      title={t('instructionsUi.dialogTitle')}
      className="instruction-dialog"
      onCancel={() => {
        if (busy) abort.current?.abort();
        else usePreferences.setState({ pdf: false });
      }}
      closable={!saving}
      mask={{ closable: !busy }}
      footer={
        busy ? (
          <Button disabled={saving} onClick={() => abort.current?.abort()}>
            {t('files.cancel')}
          </Button>
        ) : (
          <>
            <Button onClick={() => usePreferences.setState({ pdf: false })}>{t('aiUi.close')}</Button>
            <Button type="primary" onClick={() => void submit()}>
              {t('files.export')}
            </Button>
          </>
        )
      }
    >
      <div className="settings-page">
        {error && <Alert type="error" title={t('instructionsUi.failed')} />}
        {notice && <Alert type="info" title={notice} />}
        {!!issues && <Alert type="warning" title={t('instructionsUi.issues', { count: issues })} />}
        {busy ? (
          <div className="instruction-progress" role="status">
            <p>{t(saving ? 'instructionsUi.saving' : 'instructionsUi.rendering')}</p>
            <Progress
              percent={progress.totalPages ? Math.round((progress.completedPages / progress.totalPages) * 100) : 0}
            />
            <p>{t('instructionsUi.pages', progress)}</p>
          </div>
        ) : (
          <>
            <label className="settings-row">
              <span>{t('instructionsUi.paper')}</span>
              <Select
                aria-label={t('instructionsUi.paper')}
                value={options.paper}
                onChange={(paper) => patch({ paper })}
                options={['A4-landscape', 'A4-portrait', 'A5', 'Letter'].map((value) => ({
                  value,
                  label: t(`instructionsUi.papers.${value}`),
                }))}
              />
            </label>
            <label className="settings-row">
              <span>{t('instructionsUi.steps')}</span>
              <Select
                aria-label={t('instructionsUi.steps')}
                value={options.stepsPerPage}
                onChange={(stepsPerPage) => patch({ stepsPerPage })}
                options={[1, 2, 4].map((value) => ({ value, label: t('instructionsUi.stepsValue', { count: value }) }))}
              />
            </label>
            <label className="settings-row">
              <span>{t('instructionsUi.dpi')}</span>
              <Select
                aria-label={t('instructionsUi.dpi')}
                value={options.dpi}
                onChange={(dpi) => patch({ dpi })}
                options={[150, 300].map((value) => ({ value, label: `${value} dpi` }))}
              />
            </label>
            <label className="settings-row">
              <span>{t('desktop.language')}</span>
              <Select
                aria-label={t('desktop.language')}
                value={options.language ?? language}
                onChange={(language) => patch({ language })}
                options={['zh-CN', 'en'].map((value) => ({ value, label: t(`language.${value}`) }))}
              />
            </label>
            <label className="settings-row">
              <span>{t('instructionsUi.root')}</span>
              <Select
                aria-label={t('instructionsUi.root')}
                value={
                  options.rootModelId && documentSession.document.models[options.rootModelId]
                    ? options.rootModelId
                    : documentSession.document.rootModelId
                }
                onChange={(rootModelId) => patch({ rootModelId })}
                options={Object.values(documentSession.document.models).map((model) => ({
                  value: model.id,
                  label: model.name,
                }))}
              />
            </label>
            <div className="settings-actions">
              <Checkbox checked={options.includeCover} onChange={(e) => patch({ includeCover: e.target.checked })}>
                {t('instructionsUi.cover')}
              </Checkbox>
              <Checkbox checked={options.includeBom} onChange={(e) => patch({ includeBom: e.target.checked })}>
                {t('instructionsUi.bom')}
              </Checkbox>
            </div>
            <AnimationButton
              modelId={options.rootModelId ?? documentSession.document.rootModelId}
              order="steps"
              preview
            />
            <Checkbox checked={highlight} onChange={(e) => setHighlight(e.target.checked)}>
              {t('instructionsUi.highlight')}
            </Checkbox>
          </>
        )}
      </div>
    </Modal>
  );
}
