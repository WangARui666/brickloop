import { useState } from 'react';
import { Alert, Button, Modal, Tag } from 'antd';
import { Copy, FileCode2, Play, Unlink } from 'lucide-react';
import { create } from 'zustand';
import { applyOps } from '@brickloop/core';
import { toolSchemas } from '@brickloop/ai';
import {
  buildScriptOps,
  detachBuildScript,
  editedScriptOutput,
  findScript,
  prepareBuildScript,
} from '../../shared/buildscript-document';
import { activeTab, documentLocked, ensureDocumentMeshes, refresh, useDocumentStore } from './document-store';
import { useTranslation, i18n } from './store';
import { buildCatalog } from './ai-integration';
import { runBuildScriptWorker } from './buildscript-client';

const useScriptDialog = create<{ id: string | null; action: 'view' | 'run'; documentId: string | null }>(() => ({
  id: null,
  action: 'view',
  documentId: null,
}));
export function openBuildScript(id: string, action: 'view' | 'run' = 'view') {
  useDocumentStore.setState({ contextMenu: null });
  useScriptDialog.setState({ id, action, documentId: activeTab().session.document.documentId });
}
export function convertBuildScript(id: string) {
  if (documentLocked() || activeTab().readOnly) return;
  const tab = activeTab();
  tab.session.applyExternal(detachBuildScript(tab.session.document, id), i18n.t('buildScriptUi.detach'), 'ui');
  useDocumentStore.setState({ contextMenu: null });
  refresh();
}
export function BuildScriptDialog() {
  const t = useTranslation(),
    { id, action, documentId } = useScriptDialog();
  const doc = useDocumentStore((s) => s.document),
    locked = useDocumentStore((s) => s.locked);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [copied, setCopied] = useState(false);
  const output = id && documentId === doc.documentId ? findScript(doc, id) : undefined;
  const close = () => {
    if (!busy) {
      useScriptDialog.setState({ id: null });
      setError(null);
      setCopied(false);
    }
  };
  if (!output) return null;
  const script = output.script,
    edited = editedScriptOutput(doc, script.scriptId);
  const run = async (preserve = false) => {
    if (documentLocked() || activeTab().readOnly || busy) return;
    const tab = activeTab(),
      before = tab.session.document;
    setBusy(true);
    setError(null);
    try {
      // Release ownership first; the new generation must not expand through the old shared definitions.
      const detached = preserve ? detachBuildScript(before, script.scriptId) : [];
      const base = applyOps(before, detached);
      const input = toolSchemas.run_build_script.parse({ scriptId: script.scriptId });
      const prepared = prepareBuildScript(base, input),
        catalog = await buildCatalog();
      const result = await runBuildScriptWorker(prepared.code, { catalog, scope: prepared.scope, seed: prepared.seed });
      if (!result.ok) {
        setError(t('buildScriptUi.runError', { code: result.code, line: result.line ?? 1, message: result.message }));
        return;
      }
      if (tab !== activeTab() || tab.session.document !== before || documentLocked()) {
        setError(t('buildScriptUi.changed'));
        return;
      }
      const built = buildScriptOps(base, input, prepared, result);
      const applied = tab.session.applyExternal(
        [...detached, ...built.ops],
        t('buildScriptUi.runTransaction', { name: script.name }),
        'ui',
      );
      if (!applied.ok) {
        setError(t('buildScriptUi.failed'));
        return;
      }
      refresh();
      void ensureDocumentMeshes();
      useScriptDialog.setState({ action: 'view' });
    } catch {
      setError(t('buildScriptUi.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={
        <span className="build-script-title">
          <FileCode2 size={18} />
          {t(action === 'run' ? 'buildScriptUi.rerun' : 'buildScriptUi.view')} · {script.name}
        </span>
      }
      width={780}
      onCancel={close}
      mask={{ closable: !busy }}
      closable={!busy}
      className="build-script-dialog"
      footer={
        action === 'run' ? (
          <>
            <Button disabled={busy} onClick={close}>
              {t('buildScriptUi.cancel')}
            </Button>
            {edited && (
              <Button icon={<Unlink size={15} />} loading={busy} onClick={() => void run(true)}>
                {t('buildScriptUi.preserveRun')}
              </Button>
            )}
            <Button type="primary" icon={<Play size={15} />} loading={busy} onClick={() => void run()}>
              {t(edited ? 'buildScriptUi.overwrite' : 'buildScriptUi.rerun')}
            </Button>
          </>
        ) : (
          <>
            <Button
              icon={<Copy size={15} />}
              onClick={() => {
                void navigator.clipboard.writeText(script.code).then(
                  () => setCopied(true),
                  () => setError(t('buildScriptUi.copyFailed')),
                );
              }}
            >
              {t(copied ? 'buildScriptUi.copied' : 'buildScriptUi.copy')}
            </Button>
            <Button
              disabled={!!locked || activeTab().readOnly}
              icon={<Play size={15} />}
              onClick={() => useScriptDialog.setState({ action: 'run' })}
            >
              {t('buildScriptUi.rerun')}
            </Button>
            <Button type="primary" onClick={close}>
              {t('buildScriptUi.close')}
            </Button>
          </>
        )
      }
    >
      <div className="build-script-meta">
        <Tag>{t(`buildScriptUi.${script.scope}`)}</Tag>
        <span>{t('buildScriptUi.seed', { seed: script.seed })}</span>
        <span>
          {t('buildScriptUi.stats', {
            parts: script.stats.parts,
            colors: script.stats.colors,
            ms: Math.round(script.stats.ms),
          })}
        </span>
      </div>
      {action === 'run' && (
        <Alert
          showIcon
          type={edited ? 'warning' : 'info'}
          title={t(edited ? 'buildScriptUi.modifiedTitle' : 'buildScriptUi.rerunTitle')}
          description={t(edited ? 'buildScriptUi.modifiedMessage' : 'buildScriptUi.rerunMessage')}
        />
      )}
      {error && <Alert showIcon type="error" title={error} />}
      <textarea
        readOnly
        spellCheck={false}
        aria-label={t('buildScriptUi.code')}
        className="build-script-code"
        value={script.code}
      />
      <div className="build-script-hash">
        {t('buildScriptUi.hash')} <code>{script.hash}</code>
      </div>
    </Modal>
  );
}
