import { BuildAnimationDialog } from './BuildAnimationDialog';
import { useTaskStore } from './ai-task-runtime';
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ChecksPanel } from './ChecksPanel';
import { useAssemblyStore } from './assembly-store';
import { ConnectorEditor } from './ConnectorEditor';
import { expandInstances, resolveContext, transformPoint } from '@brickloop/core';
import type { Viewport } from '@brickloop/viewport';
import type { ModelInfo } from '@brickloop/io';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Alert, Button, ConfigProvider, Segmented, Tooltip } from 'antd';
import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';
import { MenuBar } from './menu';
import { useShellStore, useTranslation } from './store';
import { desktopTheme } from './theme';
import { PanelResizeHandle } from './PanelResizeHandle';
import { ViewportHost } from './ViewportHost';
import { LibraryPanel } from './LibraryPanel';
import { PalettePanel } from './PalettePanel';
import { PackManager } from './PackManager';
import { EditorToolbar } from './EditorToolbar';
import { PropertiesPanel } from './PropertiesPanel';
import { StructurePanel, EditorContextMenu } from './StructurePanel';
import { BuildScriptDialog } from './BuildScriptDialog';
import { ProjectDialogs, DocumentTabs } from './ProjectDialogs';
import { openDocuments } from './project-controller';
import { documentSession, meshes, useDocumentStore, activeTab } from './document-store';
import { displayDocumentTitle } from './document-store';
import { AiPanel } from './AiPanel';
import { AiSettings, AiStatus } from './AiSettings';
import { ImageModelDialogs } from './ImageModelDialogs';
import { MosaicDialog } from './MosaicDialog';
import { MacroDialogs } from './MacroDialogs';
import { InstructionDialog } from './InstructionDialog';
import { AboutDialog } from './AboutDialog';
import { usePreferences } from './preferences-store';

function InspectorPanel() {
  const unread = useTaskStore((s) => s.unread);
  const t = useTranslation();
  const [propertyHeight, setPropertyHeight] = useState(240),
    [propertyCollapsed, setPropertyCollapsed] = useState(false);
  const selected = useDocumentStore((state) => state.workspace.selection.length);
  const reviewBefore = useDocumentStore((state) => state.reviewBefore);
  const { rightCollapsed: collapsed, toggleRight: toggle, rightTab, setRightTab, rightWidth: width } = useShellStore();
  const collapseButton = (
    <Tooltip title={t(collapsed ? 'desktop.panels.expandInspector' : 'desktop.panels.collapseInspector')}>
      <Button
        type="text"
        size="small"
        icon={collapsed ? <ChevronLeft /> : <ChevronRight />}
        aria-label={t(collapsed ? 'desktop.panels.expandInspector' : 'desktop.panels.collapseInspector')}
        aria-expanded={!collapsed}
        onClick={toggle}
      />
    </Tooltip>
  );
  return (
    <aside
      className={`side-panel inspector-panel ${collapsed ? 'collapsed' : ''}`}
      aria-label={t('desktop.inspector.title')}
      id="inspector-panel"
      style={collapsed ? undefined : { width }}
    >
      {collapsed ? (
        <div className="panel-heading">{collapseButton}</div>
      ) : (
        <>
          <div className="inspector-heading">
            <Segmented
              value={rightTab}
              onChange={setRightTab}
              options={(['palette', 'structure', 'checks', 'ai'] as const).map((value) => ({
                value,
                label: (
                  <span>
                    {t(`desktop.inspector.${value}.title`)}
                    {value === 'ai' && unread && <i className="ai-unread" aria-label={t('parallelUi.unread')} />}
                  </span>
                ),
              }))}
            />
            {collapseButton}
          </div>
          <div
            className="inspector-content"
            inert={reviewBefore && rightTab !== 'ai'}
            aria-disabled={reviewBefore && rightTab !== 'ai'}
          >
            {rightTab === 'palette' ? (
              <PalettePanel />
            ) : rightTab === 'checks' ? (
              <ChecksPanel />
            ) : rightTab === 'structure' ? (
              <StructurePanel />
            ) : (
              <AiPanel />
            )}
          </div>
          {rightTab !== 'ai' && (
            <>
              <div
                className="property-resize"
                role="separator"
                aria-label={t('structure.resizeProperties')}
                aria-orientation="horizontal"
                aria-valuemin={120}
                aria-valuemax={480}
                aria-valuenow={propertyHeight}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    setPropertyHeight((height) =>
                      Math.max(120, Math.min(480, height + (event.key === 'ArrowUp' ? 16 : -16))),
                    );
                  }
                }}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    setPropertyCollapsed(false);
                    setPropertyHeight(
                      Math.max(
                        120,
                        Math.min(
                          480,
                          event.currentTarget.parentElement!.getBoundingClientRect().bottom - event.clientY - 36,
                        ),
                      ),
                    );
                  }
                }}
                onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
              />
              <section className="properties-dock" style={{ height: propertyCollapsed ? 36 : propertyHeight }}>
                <button
                  className="properties-dock-title"
                  aria-expanded={!propertyCollapsed}
                  onClick={() => setPropertyCollapsed(!propertyCollapsed)}
                >
                  {propertyCollapsed ? <ChevronLeft /> : <ChevronRight />}
                  {t('editor.properties')} · {t('editor.selected', { count: selected })}
                </button>
                {!propertyCollapsed && (
                  <div className="properties-scroll" inert={reviewBefore} aria-disabled={reviewBefore}>
                    {selected ? <PropertiesPanel /> : <p className="secondary">{t('structure.selectToInspect')}</p>}
                  </div>
                )}
              </section>
            </>
          )}
          <PanelResizeHandle side="right" />
        </>
      )}
    </aside>
  );
}
function StatusBar() {
  const assembly = useAssemblyStore(
    useShallow((state) => ({ checking: state.checking, collision: state.collision, hitCount: state.hitCount })),
  );
  const t = useTranslation(),
    state = useDocumentStore();
  const unit = usePreferences((s) => s.value.unit);
  const baseDocument = state.document;
  const modelId = resolveContext(baseDocument, documentSession.context)?.model.id ?? baseDocument.rootModelId;
  const stableDocument = useMemo(() => ({ ...baseDocument, rootModelId: modelId }), [baseDocument, modelId]);
  const [measured, setMeasured] = useState<{ doc: typeof stableDocument; info: ModelInfo } | null>(null);
  useEffect(() => {
    let active = true;
    const payload = { doc: stableDocument, workspace: state.workspace, assets: activeTab().assets };
    const timer = setTimeout(() => {
      void window.brickloop
        .projectInfo(payload)
        .then((info) => {
          if (active) setMeasured({ doc: stableDocument, info });
        })
        .catch(() => undefined);
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [stableDocument]);
  const summary = useMemo(() => {
    const rows = expandInstances(state.document, modelId),
      min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (const row of rows) {
      const bbox = meshes.get(row.partId)?.bboxLdu;
      if (!bbox) continue;
      for (const x of [bbox[0], bbox[3]])
        for (const y of [bbox[1], bbox[4]])
          for (const z of [bbox[2], bbox[5]]) {
            const point = transformPoint(row.worldMatrix, [x, y, z]);
            for (let i = 0; i < 3; i++) {
              min[i] = Math.min(min[i]!, point[i]!);
              max[i] = Math.max(max[i]!, point[i]!);
            }
          }
    }
    return {
      expanded: rows.length,
      dimensions:
        min[0] === Infinity
          ? [0, 0, 0]
          : [(max[0]! - min[0]!) / 20, (max[2]! - min[2]!) / 20, (max[1]! - min[1]!) / 24],
    };
  }, [state.document, modelId, state.tick]);
  const dimensions =
    measured?.doc === stableDocument
      ? [measured.info.dimensions.studs.width, measured.info.dimensions.studs.depth, measured.info.dimensions.bricks]
      : summary.dimensions;
  const current = Object.keys(resolveContext(state.document, documentSession.context)?.model.instances ?? {}).length;
  return (
    <footer className="status-bar" role="status">
      <AiStatus />
      {state.meshProgress && (
        <span>{t('performance.loadingShapes', { n: state.meshProgress.loaded, m: state.meshProgress.total })}</span>
      )}
      {assembly.checking && <span>{t('performance.checking')}</span>}
      <div className="status-group">
        {assembly.collision && assembly.hitCount > 0 && (
          <span className="check-error">{t('connectUi.hitCount', { count: assembly.hitCount })}</span>
        )}
        <span>{t('editor.count', { current, expanded: summary.expanded })}</span>
        <span className="status-separator">·</span>
        <span>
          {unit === 'stud'
            ? t('editor.dimensions', {
                x: dimensions[0]!.toFixed(2),
                z: dimensions[1]!.toFixed(2),
                y: dimensions[2]!.toFixed(2),
              })
            : t('preferences.dimensions', {
                values: dimensions
                  .map(
                    (value, index) =>
                      value * (index === 2 ? 24 : 20) * (unit === 'mm' ? 0.4 : unit === 'cm' ? 0.04 : 1),
                  )
                  .map((value) => value.toFixed(2))
                  .join(' × '),
                unit: t(`editor.units.${unit}`),
              })}
        </span>
      </div>
      <div className="status-group">
        <span>{t('desktop.status.grid', { value: state.horizontal / 20 })}</span>
        <span className="status-separator">·</span>
        <span>{t(`editor.verticalSteps.${state.vertical}`)}</span>
        <span className="status-separator">·</span>
        <span>
          {t('files.lastRecovery', {
            time: state.lastRecovery
              ? new Date(state.lastRecovery).toLocaleTimeString('en-GB', { hour12: false })
              : '—',
          })}
        </span>
      </div>
    </footer>
  );
}
export function App() {
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const t = useTranslation(),
    { language, ready, error, initialize } = useShellStore();
  const dirty = useDocumentStore((state) => state.dirty);
  const title = useDocumentStore(
    (state) => state.tabs.find((tab) => tab.id === state.activeId)?.title ?? state.document.meta.title,
  );
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = `${dirty ? '• ' : ''}${displayDocumentTitle(title)} — ${t('app.name')}`;
  }, [language, dirty, title, t]);
  return (
    <ConfigProvider
      locale={language === 'zh-CN' ? zhCN : enUS}
      theme={desktopTheme}
      button={{ autoInsertSpace: false }}
    >
      <div
        className="app-shell"
        data-ready={ready}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDrop={(event) => {
          if (event.dataTransfer.files.length) {
            event.preventDefault();
            for (const file of event.dataTransfer.files) {
              const path = window.brickloop.droppedFilePath(file);
              if (path) void openDocuments(path);
            }
          }
        }}
      >
        <header className="top-bar">
          <div className="brand" aria-label={t('app.name')} title={t('app.name')}>
            <svg
              className="brand-mark"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M19.5 7A9 9 0 0 0 3 12M4.5 17A9 9 0 0 0 21 12M3 8v4h4m14 4v-4h-4" />
              <path d="M8 9h8v7H8zM10 9V7h4v2" />
            </svg>
          </div>
          <MenuBar viewport={viewport} />
          <span className="document-title">
            {dirty ? '• ' : ''}
            {displayDocumentTitle(title)}
          </span>
        </header>
        <EditorToolbar />
        <DocumentTabs />
        {error && (
          <Alert
            type="error"
            showIcon
            title={t(`desktop.errors.${error}`)}
            action={
              error === 'load' ? <Button onClick={() => void initialize()}>{t('desktop.retry')}</Button> : undefined
            }
          />
        )}
        <main className="workspace" id="document-workspace">
          <LibraryPanel />
          <ViewportHost onReady={setViewport} />
          <InspectorPanel />
        </main>
        <StatusBar />
        <PackManager />
        <ProjectDialogs />
        <ConnectorEditor />
        <AiSettings />
        <InstructionDialog />
        <BuildAnimationDialog />
        <AboutDialog />
        <ImageModelDialogs />
        <MosaicDialog />
        <MacroDialogs />
        <EditorContextMenu />
        <BuildScriptDialog />
      </div>
    </ConfigProvider>
  );
}
