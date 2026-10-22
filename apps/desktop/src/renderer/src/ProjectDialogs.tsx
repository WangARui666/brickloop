import { useState, useRef } from 'react';
import { Alert, Button, Checkbox, Input, Modal, Select, Spin } from 'antd';
import { Copy, FileClock, X } from 'lucide-react';
import type { ModelInfo, IoIssue, ScopeOptions } from '@brickloop/io';
import type { ExportFormat, ExportRequest } from '../../shared/project-api';
import {
  activeTab,
  displayDocumentTitle,
  documentSession,
  editorViewport,
  projectPayload,
  switchDocument,
  useDocumentStore,
} from './document-store';
import {
  closeDocument,
  initializeProjects,
  recoverDocument,
  reportNext,
  runFileTask,
  useProjectUi,
} from './project-controller';
import { useTranslation, useShellStore } from './store';
import { thumbnail } from './thumbnails';
import { useLibraryStore } from './library-store';
import type { LibraryPart } from '../../shared/library-api';
import { useEffect } from 'react';
import { useAssemblyStore } from './assembly-store';

export function DocumentTabs() {
  const t = useTranslation(),
    { tabs, activeId } = useDocumentStore();
  return (
    <nav className="document-tabs" role="tablist" aria-label={t('files.tabs')}>
      {tabs.map((tab) => (
        <div key={tab.id} className={`document-tab ${tab.id === activeId ? 'current' : ''}`}>
          <button
            role="tab"
            aria-selected={tab.id === activeId}
            aria-controls="document-workspace"
            title={tab.path ?? tab.title}
            onClick={() => switchDocument(tab.id)}
          >
            {tab.dirty && <span className="dirty-dot">•</span>}
            <span>{displayDocumentTitle(tab.title)}</span>
          </button>
          <button
            className="tab-close"
            aria-label={t('files.closeTab', { name: tab.title })}
            onClick={() => void runFileTask(() => closeDocument(tab.id))}
          >
            <X />
          </button>
        </div>
      ))}
    </nav>
  );
}
export function issueText(issue: IoIssue, t: ReturnType<typeof useTranslation>) {
  const flexible = /^Flexible parameters: (\d+)$/.exec(issue.detail ?? '');
  const detail = flexible
    ? t('files.flexibleCount', { count: Number(flexible[1]) })
    : issue.code === 'IO_PART_UNMAPPED'
      ? ''
      : issue.detail;
  return `${t(issue.messageKey)}${issue.file ? ` · ${issue.file}` : ''}${detail ? ` · ${detail}` : ''}`;
}
function InfoContent({ info }: { info: ModelInfo }) {
  const lastCheck = useAssemblyStore((s) => s.lastChecks[documentSession.document.documentId]);
  const t = useTranslation(),
    d = info.dimensions;
  const dimensions = (value: { width: number; depth: number; height: number }) =>
    [value.width, value.depth, value.height].map((v) => v.toFixed(2)).join(' × ');
  const lines: [string, string | number][] = [
    [
      t('output.widthDepthHeight'),
      `${d.studs.width.toFixed(2)} × ${d.studs.depth.toFixed(2)} ${t('editor.units.stud')} × ${d.bricks.toFixed(2)} ${t('output.bricks')}`,
    ],
    [t('output.plates'), d.plates.toFixed(2)],
    [t('output.centimeters'), dimensions(d.cm)],
    [t('output.inches'), dimensions(d.inches)],
    [t('output.directReferences'), info.directReferences],
    [t('output.totalParts'), info.totalParts],
    [t('output.partTypes'), info.partTypes],
    [t('output.colorCount'), info.colorCount],
    [t('output.modelDefinitions'), info.documentSubmodelDefinitions],
    [t('output.modelInstances'), info.submodelInstances],
    [
      t('output.lastCheck'),
      lastCheck
        ? t('preferences.lastCheck', {
            time: new Date(lastCheck.at).toLocaleString(),
            count: lastCheck.count,
            scope: t(`connectUi.scopes.${lastCheck.scope}`),
          })
        : t('output.notChecked'),
    ],
  ];
  return (
    <div className="model-info-content">
      <p className="secondary">{t('output.includesStuds')}</p>
      <dl className="info-grid">
        {lines.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {!info.geometryComplete && <Alert type="warning" title={t('files.missingGeometry')} />}
      <Button
        icon={<Copy />}
        onClick={() => void window.brickloop.copyText(lines.map(([label, value]) => `${label}: ${value}`).join('\n'))}
      >
        {t('output.copyInfo')}
      </Button>
    </div>
  );
}
function ExportDialog({ initial }: { initial: ExportFormat }) {
  const t = useTranslation(),
    [format, setFormat] = useState(initial),
    [unit, setUnit] = useState<'mm' | 'cm' | 'ldu'>('mm'),
    [grouping, setGrouping] = useState<'instance' | 'color'>('instance');
  const [includeHidden, setHidden] = useState(initial === 'xlsx' || initial === 'csv'),
    [includeEdges, setEdges] = useState(false),
    [scope, setScope] = useState<'project' | 'model' | 'selection'>('project');
  const [scale, setScale] = useState(1),
    [transparent, setTransparent] = useState(false),
    [hideGrid, setHideGrid] = useState(false),
    [progress, setProgress] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const canceled = useRef(false);
  const bom = format === 'csv' || format === 'xlsx',
    mesh = ['obj', 'dae', 'glb'].includes(format),
    screenshot = format === 'png';
  async function submit() {
    setBusy(true);
    setError(null);
    canceled.current = false;
    const tab = activeTab();
    const payload = projectPayload(tab);
    const outputScope: NonNullable<ScopeOptions['scope']> =
      scope === 'project'
        ? { kind: 'project' }
        : scope === 'model'
          ? { kind: 'model', path: payload.workspace.activeModelPath }
          : { kind: 'selection', paths: payload.workspace.selection };
    const request: ExportRequest = {
      project: payload,
      format,
      unit,
      grouping,
      includeHidden,
      includeEdges,
      scope: outputScope,
      thumbnails: {},
    };
    try {
      if (format === 'io') {
        const image = await editorViewport()?.capture({ width: 512, height: 512 });
        if (image) request.project.thumbnail = image;
      }
      if (screenshot) {
        const image = await editorViewport()?.capture({ scale, transparent, hideGrid });
        if (image) request.png = image;
      }
      if (format === 'xlsx') {
        const result = await window.brickloop.projectBom(payload, {
          scope: outputScope,
          includeHidden,
          workspace: payload.workspace,
        });
        const { allColors, status } = useLibraryStore.getState();
        for (const [index, row] of result.rows.entries()) {
          setProgress(t('output.thumbnailProgress', { current: index + 1, total: result.rows.length }));
          const part = await window.brickloop.catalogPart(row.partId as LibraryPart['id']);
          const color = allColors.find((c) => c.id === row.colorId);
          if (part && color) {
            const png = await thumbnail(part, status?.pack?.id ?? 'demo', allColors, () => !canceled.current, color);
            if (png) request.thumbnails[JSON.stringify([row.partId, row.colorId])] = png;
          }
        }
      }
      if (canceled.current) return;
      setProgress(t('output.writing'));
      const result = await window.brickloop.projectExport(request);
      if (result)
        useProjectUi.setState({
          exportFormat: null,
          report: {
            kind: 'export',
            result,
            ...(result.report ? { report: result.report } : {}),
            issues: result.issues,
            path: result.path,
          },
        });
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
          : t('editor.operationFailed'),
      );
    } finally {
      setBusy(false);
      setProgress('');
    }
  }
  return (
    <Modal
      open
      width={480}
      title={t(screenshot ? 'output.screenshot' : bom ? 'output.bom' : 'files.export')}
      onCancel={() => {
        if (busy) canceled.current = true;
        else useProjectUi.setState({ exportFormat: null });
      }}
      footer={
        <>
          <Button
            onClick={() => {
              if (busy) canceled.current = true;
              else useProjectUi.setState({ exportFormat: null });
            }}
          >
            {t('files.cancel')}
          </Button>
          <Button type="primary" loading={busy} onClick={() => void submit()}>
            {t('files.export')}
          </Button>
        </>
      }
    >
      <div className="export-form">
        {!screenshot && (
          <label>
            <span>{t('output.format')}</span>
            <Select
              aria-label={t('output.format')}
              value={format}
              disabled={busy}
              onChange={(value) => {
                setFormat(value);
                setHidden(value === 'csv' || value === 'xlsx');
              }}
              options={(bom ? ['csv', 'xlsx'] : ['io', 'ldr', 'mpd', 'obj', 'dae', 'glb']).map((value) => ({
                value,
                label: t(`output.formats.${value}`),
              }))}
            />
          </label>
        )}
        {mesh && (
          <>
            <label>
              <span>{t('output.unit')}</span>
              <Select
                aria-label={t('output.unit')}
                value={unit}
                onChange={setUnit}
                options={(['mm', 'cm', 'ldu'] as const).map((value) => ({ value, label: t(`output.units.${value}`) }))}
              />
            </label>
            <label>
              <span>{t('output.grouping')}</span>
              <Select
                aria-label={t('output.grouping')}
                value={grouping}
                disabled={format !== 'obj'}
                onChange={setGrouping}
                options={(['instance', 'color'] as const).map((value) => ({
                  value,
                  label: t(`output.groups.${value}`),
                }))}
              />
            </label>
          </>
        )}
        {(bom || mesh) && (
          <>
            <label>
              <span>{t('output.scope')}</span>
              <Select
                aria-label={t('output.scope')}
                value={scope}
                onChange={setScope}
                options={(['project', 'model', 'selection'] as const).map((value) => ({
                  value,
                  label: t(`output.scopes.${value}`),
                  disabled: value === 'selection' && !documentSession.workspace.selection.length,
                }))}
              />
            </label>
            <Checkbox checked={includeHidden} onChange={(e) => setHidden(e.target.checked)}>
              {t('output.includeHidden')}
            </Checkbox>
          </>
        )}
        {mesh && (
          <Checkbox checked={includeEdges} onChange={(e) => setEdges(e.target.checked)}>
            {t('output.includeEdges')}
          </Checkbox>
        )}
        {screenshot && (
          <>
            <label>
              <span>{t('output.resolution')}</span>
              <Select
                aria-label={t('output.resolution')}
                value={scale}
                onChange={setScale}
                options={[1, 2, 4].map((value) => ({ value, label: `${value}×` }))}
              />
            </label>
            <Checkbox checked={transparent} onChange={(e) => setTransparent(e.target.checked)}>
              {t('output.transparent')}
            </Checkbox>
            <Checkbox checked={hideGrid} onChange={(e) => setHideGrid(e.target.checked)}>
              {t('output.hideGrid')}
            </Checkbox>
          </>
        )}
        {(format === 'io' || format === 'ldr' || format === 'mpd') && (
          <p className="secondary">{t('output.exchangeHint')}</p>
        )}
        {error && <Alert type="error" title={error} />}
        {busy && (
          <div className="export-progress">
            <Spin size="small" />
            {progress || t('files.working')}
          </div>
        )}
      </div>
    </Modal>
  );
}
export function ProjectDialogs() {
  const t = useTranslation(),
    state = useProjectUi();
  const ready = useShellStore((s) => s.ready);
  useEffect(() => {
    if (ready) void initializeProjects().catch(() => useProjectUi.setState({ error: t('files.recoveryFailed') }));
  }, [ready]);
  const issues = state.report
    ? [
        ...state.report.issues,
        ...(state.report.report
          ? [
              ...state.report.report.errors,
              ...state.report.report.warnings,
              ...state.report.report.degradations,
              ...state.report.report.omitted,
            ]
          : []),
      ]
    : [];
  const counts = state.report?.report?.counts;
  const reportLines = [
    state.report?.path ?? '',
    counts ? t('files.importSummary', counts) : '',
    ...issues.map((issue) => issueText(issue, t)),
  ].filter(Boolean);
  function resolveChoice(value: string) {
    const callback = state.choice?.resolve;
    useProjectUi.setState({ choice: null });
    callback?.(value);
  }
  function resolveName(value: string | null) {
    const callback = state.namePrompt?.resolve;
    useProjectUi.setState({ namePrompt: null });
    callback?.(value);
  }
  return (
    <>
      {state.busy && (
        <div className="file-progress" role="status">
          <Spin size="small" />
          {t('files.working')}
        </div>
      )}
      <Modal
        open={!!state.namePrompt}
        title={state.namePrompt?.title}
        width={480}
        onCancel={() => resolveName(null)}
        onOk={() => resolveName(state.namePrompt?.value.trim() || null)}
        okText={t('files.confirm')}
        cancelText={t('files.cancel')}
        okButtonProps={{ disabled: !state.namePrompt?.value.trim() }}
        destroyOnHidden
      >
        <Input
          autoFocus
          aria-label={t('structure.name')}
          maxLength={120}
          value={state.namePrompt?.value}
          onChange={(event) =>
            useProjectUi.setState({
              namePrompt: state.namePrompt ? { ...state.namePrompt, value: event.target.value } : null,
            })
          }
          onPressEnter={() => resolveName(state.namePrompt?.value.trim() || null)}
        />
      </Modal>
      <Modal
        open={!!state.choice}
        title={state.choice?.title}
        width={480}
        onCancel={() => resolveChoice('cancel')}
        footer={state.choice?.options.map((option, index) => (
          <Button
            key={option.key}
            type={index === state.choice!.options.length - 1 ? 'primary' : 'default'}
            onClick={() => resolveChoice(option.key)}
          >
            {option.label}
          </Button>
        ))}
      >
        <p>{state.choice?.message}</p>
      </Modal>
      <Modal
        open={!!state.error}
        title={t('files.failed')}
        width={480}
        onCancel={() => useProjectUi.setState({ error: null })}
        footer={
          <Button type="primary" onClick={() => useProjectUi.setState({ error: null })}>
            {t('files.confirm')}
          </Button>
        }
      >
        <Alert type="error" showIcon title={state.error} />
      </Modal>
      <Modal
        open={state.recoverable.length > 0}
        title={t('files.recoveryTitle')}
        width={640}
        closable={false}
        mask={{ closable: false }}
        footer={null}
      >
        <p className="secondary">{t('files.recoveryDescription')}</p>
        <div className="recovery-list">
          {state.recoverable.map((item) => (
            <section key={item.documentId} className="recovery-item">
              <div className="recovery-name">
                <FileClock />
                <strong>{item.title}</strong>
              </div>
              <p className="recovery-path">{item.projectPath ?? t('files.unsavedPath')}</p>
              <div className="secondary">
                {t('files.recoveryTime', {
                  time: item.lastRecoveredAt ? new Date(item.lastRecoveredAt).toLocaleString() : t('files.unknownTime'),
                  count: item.recoverableTransactions,
                })}
              </div>
              <div className="dialog-actions">
                <Button disabled={state.busy} onClick={() => void recoverDocument(item, 'discard')}>
                  {t('files.discardRecovery')}
                </Button>
                <Button disabled={state.busy || !item.doc} onClick={() => void recoverDocument(item, 'saveAs')}>
                  {t('files.saveAs')}
                </Button>
                <Button
                  type="primary"
                  disabled={state.busy || !item.doc}
                  onClick={() => void recoverDocument(item, 'recover')}
                >
                  {t('files.recover')}
                </Button>
              </div>
            </section>
          ))}
        </div>
      </Modal>
      <Modal
        open={!!state.report}
        title={t(
          state.report?.kind === 'import'
            ? 'files.importReport'
            : state.report?.kind === 'export'
              ? 'files.exportReport'
              : 'files.report',
        )}
        width={640}
        onCancel={reportNext}
        footer={
          <>
            <Button onClick={() => void runFileTask(() => window.brickloop.projectReport(reportLines.join('\n')))}>
              {t('files.saveReport')}
            </Button>
            <Button type="primary" onClick={reportNext}>
              {t('files.confirm')}
            </Button>
          </>
        }
      >
        <div className="report-content">
          {state.report?.path && <p className="report-path">{state.report.path}</p>}
          {counts && (
            <>
              <div className="report-counts">
                <div>
                  <strong>{counts.parts}</strong>
                  <span>{t('output.totalParts')}</span>
                </div>
                <div>
                  <strong>{counts.submodels}</strong>
                  <span>{t('output.modelDefinitions')}</span>
                </div>
                <div>
                  <strong>{counts.steps}</strong>
                  <span>{t('structure.steps')}</span>
                </div>
              </div>
              <p className="secondary">
                {t('files.mappingSummary', { parts: counts.unmappedParts, colors: counts.unmappedColors })}
              </p>
            </>
          )}
          {state.report?.result && (
            <div className="export-result">
              <p>{t('output.fileSize', { size: (state.report.result.byteLength / 1024).toFixed(2) })}</p>
              {state.report.result.triangleCount !== undefined && (
                <p>{t('output.triangles', { count: state.report.result.triangleCount })}</p>
              )}
              {state.report.result.bom && (
                <p>
                  {t('output.bomSummary', {
                    ...state.report.result.bom.summary,
                    images: state.report.result.thumbnailCount ?? 0,
                  })}
                </p>
              )}
            </div>
          )}
          {!!state.report?.report?.omitted.length && <h3>{t('files.omitted')}</h3>}
          {issues.length ? (
            <ul className="report-issues">
              {issues.map((issue, index) => (
                <li key={index} className={issue.severity === 'error' ? 'issue-error' : ''}>
                  {issueText(issue, t)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="secondary">{t('files.noIssues')}</p>
          )}
        </div>
      </Modal>
      {state.exportFormat && <ExportDialog key={state.exportFormat} initial={state.exportFormat} />}
      <Modal
        open={!!state.info}
        title={t('output.modelInfo')}
        width={480}
        onCancel={() => useProjectUi.setState({ info: null })}
        footer={
          <Button type="primary" onClick={() => useProjectUi.setState({ info: null })}>
            {t('files.confirm')}
          </Button>
        }
      >
        {state.info && <InfoContent info={state.info} />}
      </Modal>
    </>
  );
}
