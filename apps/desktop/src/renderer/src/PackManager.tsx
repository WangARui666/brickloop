import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Modal, Popconfirm, Spin } from 'antd';
import { FolderOpen, Upload } from 'lucide-react';
import type { ImportReview, PackSummary } from '../../shared/library-api';
import { useLibraryStore } from './library-store';
import { useShellStore, useTranslation } from './store';
import { expandInstances } from '@brickloop/core';
import type { ColorId, PartId } from '@brickloop/catalog';
import type { LibraryApi } from '../../shared/library-api';
import { documentTabs } from './document-store';

export function PackManager() {
  const t = useTranslation();
  const { managerOpen, openManager, refresh, pendingReview } = useLibraryStore();
  const [packs, setPacks] = useState<PackSummary[]>([]);
  const [review, setReview] = useState<ImportReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState('');
  const [activate, setActivate] = useState(true);
  const operation = useRef(0);
  const [impact, setImpact] = useState<{
    rows: Awaited<ReturnType<LibraryApi['packsImpact']>>;
    parts: Record<string, string>;
    colors: Record<string, string>;
    resolve(yes: boolean): void;
  } | null>(null);
  async function confirmImpact(target: { id?: string; token?: string }) {
    const documents = [...documentTabs.values()].map(({ session }) => ({
      title: session.document.meta.title,
      references: Object.keys(session.document.models).flatMap((rootModelId) =>
        expandInstances({ ...session.document, rootModelId }).map((row) => ({
          partId: row.partId as PartId,
          colorId: row.colorId as ColorId,
        })),
      ),
    }));
    const rows = (await window.brickloop.packsImpact(target, documents)).filter(
      ({ impact }) =>
        impact.nonFactoryParts.length || impact.nonFactoryColors.length || impact.unavailableColors.length,
    );
    if (!rows.length) return true;
    const partIds = [
      ...new Set(
        rows.flatMap(({ impact }) => [
          ...impact.nonFactoryParts,
          ...impact.unavailableColors.map((item) => item.partId),
        ]),
      ),
    ];
    const language = useShellStore.getState().language;
    const parts = Object.fromEntries(
      await Promise.all(
        partIds.map(async (id) => {
          const part = await window.brickloop.catalogPart(id);
          return [
            id,
            part
              ? `${language === 'zh-CN' ? part.nameZh : part.nameEn} · ${part.legoNo ?? part.factoryNo ?? id.slice(3)}`
              : id.slice(3),
          ];
        }),
      ),
    );
    const colors = Object.fromEntries(
      useLibraryStore
        .getState()
        .allColors.map((color) => [
          color.id,
          `${language === 'zh-CN' ? color.nameZh : (color.legoName ?? color.nameZh)}${color.factoryCode ? ` · ${color.factoryCode}` : ''}`,
        ]),
    );
    return new Promise<boolean>((resolve) => setImpact({ rows, parts, colors, resolve }));
  }
  useEffect(() => {
    if (pendingReview) {
      setReview(pendingReview);
      useLibraryStore.setState({ pendingReview: null });
    }
  }, [pendingReview]);
  useEffect(() => {
    if (managerOpen) {
      setError(false);
      setNotice('');
      void window.brickloop
        .packsList()
        .then(setPacks)
        .catch(() => setError(true));
    }
  }, [managerOpen]);
  async function run(action: () => Promise<void>) {
    const id = ++operation.current;
    setBusy(true);
    setError(false);
    setNotice('');
    try {
      await action();
    } catch {
      if (id === operation.current) setError(true);
    } finally {
      if (id === operation.current) setBusy(false);
    }
  }
  async function update() {
    setPacks(await window.brickloop.packsList());
    await refresh();
  }
  function close() {
    ++operation.current;
    if (review) void window.brickloop.packsImport({ action: 'cancel', token: review.token }).catch(() => undefined);
    setReview(null);
    setBusy(false);
    openManager(false);
  }
  function choose(kind: 'file' | 'directory') {
    void run(async () => {
      const id = operation.current;
      const result = await window.brickloop.packsImport({ action: 'choose', kind });
      if (id === operation.current) setReview(result);
      else if (result) await window.brickloop.packsImport({ action: 'cancel', token: result.token });
    });
  }
  return (
    <>
      <Modal
        open={!!impact}
        title={t('packImpact.title')}
        width={640}
        className="pack-impact-dialog"
        okText={t('packImpact.continue')}
        cancelText={t('files.cancel')}
        onCancel={() => {
          impact?.resolve(false);
          setImpact(null);
        }}
        onOk={() => {
          impact?.resolve(true);
          setImpact(null);
        }}
      >
        <p className="secondary">{t('packImpact.hint')}</p>
        <div className="pack-impact-list">
          {impact?.rows.map((row, index) => (
            <section key={index}>
              <h3>{row.title}</h3>
              {!!row.impact.nonFactoryParts.length && (
                <p>
                  {t('packImpact.parts')}：
                  {row.impact.nonFactoryParts.map((id) => impact.parts[id] ?? id.slice(3)).join('、')}
                </p>
              )}
              {!!row.impact.nonFactoryColors.length && (
                <p>
                  {t('packImpact.colors')}：
                  {row.impact.nonFactoryColors
                    .map((id) => impact.colors[id] ?? id.slice(id.indexOf(':') + 1))
                    .join('、')}
                </p>
              )}
              {!!row.impact.unavailableColors.length && (
                <p>
                  {t('packImpact.combinations')}：
                  {row.impact.unavailableColors
                    .map(
                      (v) =>
                        `${impact.parts[v.partId] ?? v.partId.slice(3)} / ${impact.colors[v.colorId] ?? v.colorId.slice(v.colorId.indexOf(':') + 1)}`,
                    )
                    .join('、')}
                </p>
              )}
            </section>
          ))}
        </div>
      </Modal>
      <Modal
        title={t('libraryUi.manage')}
        open={managerOpen}
        width={640}
        onCancel={close}
        footer={null}
        destroyOnHidden
        className="pack-manager"
      >
        <div className="pack-dialog-content">
          {error && <Alert type="error" title={t('libraryUi.operationFailed')} />}
          {notice && <Alert type="success" title={notice} />}
          {busy && (
            <div className="pack-progress" role="status">
              <Spin size="small" />
              <span>{t('libraryUi.processing')}</span>
            </div>
          )}
          {review ? (
            <>
              <h3>{t('libraryUi.validation')}</h3>
              <p className="secondary">
                {t('libraryUi.accepted', {
                  parts: review.report.acceptedParts,
                  colors: review.report.acceptedColors,
                  skipped: review.report.skippedRows,
                })}
              </p>
              {!!(review.report.errors.length + review.report.warnings.length) && (
                <div className="import-issues" role="log">
                  {[...review.report.errors, ...review.report.warnings].map((issue, index) => (
                    <div className={index < review.report.errors.length ? 'issue-error' : 'issue-warning'} key={index}>
                      <strong>
                        {issue.file} · {issue.row ? t('libraryUi.row', { row: issue.row }) : t('libraryUi.fileIssue')}
                        {issue.column ? ` · ${issue.column}` : ''}
                      </strong>
                      <p>{issue.reason}</p>
                    </div>
                  ))}
                </div>
              )}
              {review.manifest && review.diff && (
                <div className="pack-diff">
                  <h3>{t('libraryUi.diffTitle', { name: review.manifest.name })}</h3>
                  <table>
                    <thead>
                      <tr>
                        <th>{t('libraryUi.items')}</th>
                        <th>{t('libraryUi.added')}</th>
                        <th>{t('libraryUi.removed')}</th>
                        <th>{t('libraryUi.changed')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(['parts', 'colors'] as const).map((kind) => (
                        <tr key={kind}>
                          <td>{t(`libraryUi.${kind}`)}</td>
                          <td>{review.diff![kind].added.length}</td>
                          <td>{review.diff![kind].removed.length}</td>
                          <td>{review.diff![kind].changed.length}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {review.manifest && (
                <Checkbox checked={activate} disabled={busy} onChange={(event) => setActivate(event.target.checked)}>
                  {t('libraryUi.activateAfter')}
                </Checkbox>
              )}
              <div className="dialog-actions">
                <Button
                  disabled={busy}
                  onClick={() => {
                    void run(async () => {
                      await window.brickloop.packsImport({ action: 'cancel', token: review.token });
                      setReview(null);
                    });
                  }}
                >
                  {t('libraryUi.cancel')}
                </Button>
                {review.manifest ? (
                  <Button
                    type="primary"
                    loading={busy}
                    onClick={() =>
                      void run(async () => {
                        if (activate && !(await confirmImpact({ token: review.token }))) return;
                        const result = await window.brickloop.packsImport({
                          action: 'commit',
                          token: review.token,
                          activate,
                        });
                        if (result?.imported) {
                          setReview(null);
                          await update();
                          setNotice(t('libraryUi.imported'));
                        } else setReview(result);
                      })
                    }
                  >
                    {t('libraryUi.confirmImport')}
                  </Button>
                ) : (
                  <Button
                    type="primary"
                    disabled={!review.report.errors.some((issue) => issue.row >= 3)}
                    loading={busy}
                    onClick={() =>
                      void run(async () =>
                        setReview(
                          await window.brickloop.packsImport({
                            action: 'review',
                            token: review.token,
                            skipInvalidRows: true,
                          }),
                        ),
                      )
                    }
                  >
                    {t('libraryUi.skipErrors')}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="secondary">{t('libraryUi.packHelp')}</p>
              <div className="pack-list">
                {packs.map((pack) => (
                  <article className="pack-entry" key={pack.id} data-pack-id={pack.id}>
                    <div className="pack-title">
                      <strong>{pack.name}</strong>
                      <span className="secondary">{pack.version}</span>
                      {pack.active && <span className="active-badge">{t('libraryUi.active')}</span>}
                    </div>
                    <p className="secondary">
                      {t('libraryUi.packCounts', { parts: pack.partCount, colors: pack.colorCount })}
                    </p>
                    <p className="pack-source">{t('libraryUi.source', { source: pack.source })}</p>
                    <div className="pack-actions">
                      <Button
                        size="small"
                        disabled={busy || pack.active}
                        onClick={() =>
                          void run(async () => {
                            if (!(await confirmImpact({ id: pack.id }))) return;
                            await window.brickloop.packsActivate(pack.id);
                            await update();
                          })
                        }
                      >
                        {t('libraryUi.activate')}
                      </Button>
                      <Button
                        size="small"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const file = await window.brickloop.packsExportTemplate(pack.id);
                            if (file) setNotice(t('libraryUi.exported', { path: file }));
                          })
                        }
                      >
                        {t('libraryUi.exportTemplate')}
                      </Button>
                      <Popconfirm
                        title={t('libraryUi.deleteConfirm', { name: pack.name })}
                        okText={t('libraryUi.remove')}
                        cancelText={t('libraryUi.cancel')}
                        onConfirm={() =>
                          void run(async () => {
                            await window.brickloop.packsRemove(pack.id);
                            await update();
                          })
                        }
                      >
                        <Button size="small" disabled={busy || pack.id === 'demo' || pack.active}>
                          {t('libraryUi.remove')}
                        </Button>
                      </Popconfirm>
                    </div>
                  </article>
                ))}
              </div>
              <p className="secondary import-help">{t('libraryUi.xlsxHelp')}</p>
              <div className="dialog-actions pack-main-actions">
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const file = await window.brickloop.packsExportTemplate();
                      if (file) setNotice(t('libraryUi.exported', { path: file }));
                    })
                  }
                >
                  {t('libraryUi.exportBlank')}
                </Button>
                <Button icon={<FolderOpen />} disabled={busy} onClick={() => choose('directory')}>
                  {t('libraryUi.importDirectory')}
                </Button>
                <Button type="primary" icon={<Upload />} loading={busy} onClick={() => choose('file')}>
                  {t('libraryUi.importPack')}
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
