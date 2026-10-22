import { Button, Checkbox, Select, Alert, Spin } from 'antd';
import { useShallow } from 'zustand/react/shallow';
import { ClipboardCheck, RefreshCw, Grid2X2, ChevronRight, ChevronDown } from 'lucide-react';
import { lduToGrid } from '@brickloop/ai';
import { executeCommand, resolvePath, expandInstances } from '@brickloop/core';
import type { Issue } from '@brickloop/collide';
import type { Op } from '@brickloop/core';
import {
  documentSession,
  enterContext,
  selectPaths,
  editorViewport,
  refresh,
  useDocumentStore,
  ensureDocumentMeshes,
} from './document-store';
import { refreshChecks, setAssemblyOption, useAssemblyStore, partNames } from './assembly-store';
import { useLibraryStore } from './library-store';
import { documentLocked } from './document-store';
import { useTranslation, i18n } from './store';

export function locateIssue(issue: Issue) {
  const first = issue.paths[0];
  if (!first) return;
  let parent = first.slice(0, -1);
  while (parent.length && issue.paths.some((path) => path.slice(0, parent.length).join('/') !== parent.join('/')))
    parent = parent.slice(0, -1);
  enterContext(parent);
  const selection = [
    ...new Map(
      issue.paths.map((path) => path.slice(0, parent.length + 1)).map((path) => [path.join('/'), path]),
    ).values(),
  ];
  documentSession.updateWorkspace({
    hidden: documentSession.workspace.hidden.filter(
      (hidden) => !issue.paths.some((path) => path.slice(0, hidden.length).join('/') === hidden.join('/')),
    ),
  });
  selectPaths(selection);
  editorViewport()?.fitSelection(issue.paths);
}
export function alignIssues() {
  if (documentLocked()) return;
  const state = useDocumentStore.getState(),
    ops: Op[] = [];
  const paths = new Map(
    useAssemblyStore
      .getState()
      .issues.filter((issue) => issue.kind === 'offGrid')
      .flatMap((issue) => issue.paths)
      .map((path) => [path.join('/'), path]),
  );
  for (const path of paths.values()) {
    const row = resolvePath(documentSession.document, path);
    if (!row) continue;
    const delta = [state.horizontal, state.vertical, state.horizontal].map(
      (step, i) => Math.round(row.worldMatrix[12 + i]! / step) * step - row.worldMatrix[12 + i]!,
    ) as [number, number, number];
    const result = executeCommand(
      documentSession.document,
      { activeModelPath: path.slice(0, -1), selection: [path] },
      { type: 'transform.translate', delta, space: 'world' },
    );
    if (result.ok) ops.push(...result.value.ops);
  }
  if (ops.length) documentSession.applyExternal(ops, i18n.t('connectUi.alignGrid'), 'ui');
  refresh();
}
export function ChecksPanel() {
  const missingMeshes = useDocumentStore((state) => state.missingMeshes);
  const state = useAssemblyStore(
      useShallow((state) => ({
        issues: state.issues,
        scope: state.scope,
        visibleOnly: state.visibleOnly,
        groundIsFixed: state.groundIsFixed,
        checking: state.checking,
        error: state.error,
      })),
    ),
    t = useTranslation();
  const colors = useLibraryStore((s) => s.allColors);
  const doc = useDocumentStore((s) => s.document);
  const expanded = new Map(expandInstances(doc).map((row) => [row.path.join('/'), row]));
  function grouped(issues: Issue[]) {
    const rows = new Map<
      string,
      { label: string; color: string; paths: string[][]; issues: Issue[]; pathKeys: Set<string>; issueSet: Set<Issue> }
    >();
    for (const issue of issues)
      for (const path of issue.paths) {
        const instance = resolvePath(doc, path)?.instance;
        if (!instance || instance.ref.kind !== 'part') continue;
        const part = partNames.get(instance.ref.partId),
          colorId = expanded.get(path.join('/'))?.colorId ?? instance.colorId,
          color = colors.find((c) => c.id === colorId),
          key = `${instance.ref.partId}/${colorId}`;
        const row = rows.get(key) ?? {
          label: `${(i18n.language === 'en' ? part?.nameEn : part?.nameZh) ?? instance.ref.partId} · ${(i18n.language === 'en' ? color?.legoName : color?.nameZh) ?? colorId}`,
          color: color?.rgb ?? 'transparent',
          paths: [],
          issues: [],
          pathKeys: new Set<string>(),
          issueSet: new Set<Issue>(),
        };
        const pathKey = path.join('/');
        if (!row.pathKeys.has(pathKey)) {
          row.pathKeys.add(pathKey);
          row.paths.push(path);
        }
        if (!row.issueSet.has(issue)) {
          row.issueSet.add(issue);
          row.issues.push(issue);
        }
        rows.set(key, row);
      }
    return [...rows.entries()];
  }
  const groups = ['error', 'warning', 'info', 'unknown'] as const;
  return (
    <div className="checks-panel">
      {!!missingMeshes.length && (
        <Alert
          type="error"
          title={t('performance.missingShapes')}
          description={missingMeshes.join(', ')}
          action={<Button onClick={() => void ensureDocumentMeshes()}>{t('performance.retry')}</Button>}
        />
      )}
      <div className="checks-controls">
        <div className="checks-scope-row">
          <Select
            aria-label={t('connectUi.scope')}
            value={state.scope}
            onChange={(value) => setAssemblyOption('scope', value)}
            options={(['project', 'currentModel', 'selection'] as const).map((value) => ({
              value,
              label: t(`connectUi.scopes.${value}`),
            }))}
          />
          <Button
            type="text"
            size="small"
            icon={<RefreshCw />}
            aria-label={t('connectUi.refresh')}
            onClick={() => void refreshChecks()}
          />
        </div>
        <Checkbox checked={state.visibleOnly} onChange={(e) => setAssemblyOption('visibleOnly', e.target.checked)}>
          {t('connectUi.visibleOnly')}
        </Checkbox>
        <Checkbox checked={state.groundIsFixed} onChange={(e) => setAssemblyOption('groundIsFixed', e.target.checked)}>
          {t('connectUi.groundFixed')}
        </Checkbox>
      </div>
      {state.error && <Alert type="error" title={state.error} />}
      <div className="check-counts">
        {groups.map((group) => (
          <span key={group} className={`check-${group}`}>
            {t(`connectUi.levels.${group}`)}{' '}
            {
              state.issues.filter((issue) =>
                group === 'unknown'
                  ? issue.kind === 'collisionUnknown'
                  : issue.kind !== 'collisionUnknown' && issue.severity === group,
              ).length
            }
          </span>
        ))}
        {state.checking && (
          <>
            <Spin size="small" />
            {t('performance.checking')}
          </>
        )}
      </div>
      <div className="check-results">
        {groups.map((group) => {
          const issues = state.issues.filter((issue) =>
            group === 'unknown'
              ? issue.kind === 'collisionUnknown'
              : issue.kind !== 'collisionUnknown' && issue.severity === group,
          );
          if (!issues.length) return null;
          return (
            <section key={group}>
              <h3 className={`check-${group}`}>
                {t(`connectUi.levels.${group}`)} · {issues.length}
              </h3>
              {[...new Set(issues.map((issue) => issue.kind))].map((kind) => (
                <div key={kind} className="check-kind">
                  <h4>{t(`checkTitles.${kind}`)}</h4>
                  {grouped(issues.filter((issue) => issue.kind === kind)).map(([key, row]) => (
                    <details className="check-group" key={key}>
                      <summary
                        key={key}
                        className="check-item"
                        data-issue-kind={kind}
                        onClick={() =>
                          locateIssue({
                            ...row.issues[0]!,
                            paths: row.paths,
                          })
                        }
                      >
                        <span className="check-part-name">
                          <ChevronRight className="tool-closed" />
                          <ChevronDown className="tool-open" />
                          <i style={{ backgroundColor: row.color }} />
                          {row.label}
                        </span>
                        <small>{t('aiUi.checkObjects', { count: row.paths.length, issues: row.issues.length })}</small>
                      </summary>
                      {row.paths.map((path, index) => {
                        const matrix = expanded.get(path.join('/'))?.worldMatrix;
                        if (!matrix) return null;
                        const position = lduToGrid({ x_ldu: matrix[12]!, y_ldu: matrix[13]!, z_ldu: matrix[14]! });
                        const number = (value: number) => Number(value.toFixed(2));
                        return (
                          <button
                            className="check-instance"
                            key={path.join('/')}
                            onClick={() => locateIssue({ ...row.issues[0]!, paths: [path] })}
                          >
                            {t('aiUi.checkInstance', {
                              n: index + 1,
                              x: number(position.x),
                              z: number(position.z),
                              level: number(position.level),
                            })}
                          </button>
                        );
                      })}
                    </details>
                  ))}
                </div>
              ))}
            </section>
          );
        })}
        {!state.issues.length && !state.checking && (
          <div className="empty-state">
            <ClipboardCheck />
            <p>{t('connectUi.noIssues')}</p>
          </div>
        )}
      </div>
      <Button
        icon={<Grid2X2 />}
        disabled={documentLocked() || !state.issues.some((issue) => issue.kind === 'offGrid')}
        onClick={alignIssues}
      >
        {t('connectUi.alignGrid')}
      </Button>
    </div>
  );
}
