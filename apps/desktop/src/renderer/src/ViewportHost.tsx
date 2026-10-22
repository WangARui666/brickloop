import { useEffect, useRef, useState } from 'react';
import { Alert, Button } from 'antd';
import { createViewport } from '@brickloop/viewport';
import type { Viewport } from '@brickloop/viewport';
import { resolveContext, resolvePath, groupAncestors } from '@brickloop/core';
import { ChevronRight } from 'lucide-react';
import { modelReferences } from './StructurePanel';
import { makeContextUnique, placeSubmodel } from './project-controller';
import { useTranslation, useShellStore } from './store';
import {
  bindViewport,
  documentSession,
  editorKey,
  enterContext,
  selectPaths,
  startPlacement,
  useDocumentStore,
} from './document-store';
import { useLibraryStore } from './library-store';
import { useShallow } from 'zustand/react/shallow';
import { useAssemblyStore } from './assembly-store';
import { placeMacro } from './macro-store';
import { ReviewBar } from './ReviewPanel';
import { StepNavigation } from './StepsPanel';
import { SelectionAsk } from './SelectionAsk';

export function ViewportHost({ onReady }: { onReady(viewport: Viewport | null): void }) {
  const chosen = useAssemblyStore((state) => state.chosen !== null);
  const host = useRef<HTMLDivElement>(null),
    [error, setError] = useState(false),
    [attempt, setAttempt] = useState(0);
  const t = useTranslation(),
    state = useDocumentStore(
      useShallow((state) => ({
        document: documentSession.isPreviewing ? documentSession.transactionBase : state.document,
        workspace: state.workspace,
        placement: state.placement,
        clipboardPlacement: state.clipboardPlacement,
        eyedropper: state.eyedropper,
        contextMenu: state.contextMenu,
        loading: state.loading,
        error: state.error,
        locked: state.locked,
        reviewBefore: state.reviewBefore,
      })),
    ),
    language = useShellStore((s) => s.language);
  const { allColors } = useLibraryStore();
  useEffect(() => {
    let canceled = false;
    let viewport: Viewport | undefined;
    setError(false);
    void createViewport(host.current!)
      .then((created) => {
        if (canceled) {
          created.dispose();
          return;
        }
        viewport = created;
        bindViewport(created);
        onReady(created);
      })
      .catch(() => {
        if (!canceled) setError(true);
      });
    function key(event: KeyboardEvent) {
      editorKey(event);
    }
    window.addEventListener('keydown', key);
    return () => {
      canceled = true;
      window.removeEventListener('keydown', key);
      bindViewport(null);
      viewport?.dispose();
      onReady(null);
    };
  }, [attempt, onReady]);
  useEffect(() => {
    selectPaths(documentSession.workspace.selection);
  }, [allColors]);
  const context = resolveContext(state.document, documentSession.context);
  const references =
    context && state.workspace.activeModelPath.length
      ? (modelReferences(state.document).get(context.model.id) ?? 0)
      : 0;
  return (
    <section
      className={`viewport ${state.eyedropper ? 'eyedropper' : ''}`}
      data-testid="viewport-host"
      aria-label={t('desktop.viewport.title')}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        if (state.reviewBefore || event.dataTransfer.files.length) return;
        event.preventDefault();
        const macro = event.dataTransfer.getData('application/x-brickloop-macro');
        if (macro) {
          void placeMacro(macro, { x: event.clientX, y: event.clientY });
          return;
        }
        const model = event.dataTransfer.getData('application/x-brickloop-model');
        if (model) {
          void placeSubmodel(model, { x: event.clientX, y: event.clientY });
          return;
        }
        const part = useLibraryStore.getState().selected;
        if (part) void startPlacement(part, { x: event.clientX, y: event.clientY });
      }}
    >
      <div className="viewport-surface" ref={host} tabIndex={0} />
      <StepNavigation />
      <ReviewBar />
      <SelectionAsk />
      {state.clipboardPlacement?.macro?.warning && (
        <Alert className="macro-warning" type="warning" showIcon title={state.clipboardPlacement.macro.warning} />
      )}
      {chosen && <div className="snap-legend">{t('connectUi.snapLegend')}</div>}
      {state.clipboardPlacement && (
        <div className="preview-label">
          {t('editor.preview', { name: state.clipboardPlacement.name })} · {t('structure.placeHint')}
        </div>
      )}
      {state.placement && (
        <div className="preview-label">
          {t('editor.preview', {
            name: language === 'zh-CN' ? state.placement.part.nameZh : state.placement.part.nameEn,
          })}
        </div>
      )}
      {!state.placement &&
        !state.locked &&
        !state.clipboardPlacement &&
        !Object.keys(state.document.models[state.document.rootModelId]!.instances).length && (
          <div className="preview-empty">{t('editor.empty')}</div>
        )}
      {state.eyedropper && <div className="preview-label">{t('editor.pickColor')}</div>}
      {
        <div className="context-breadcrumb">
          <button
            disabled={state.reviewBefore}
            onClick={() => {
              enterContext([]);
            }}
          >
            {t('editor.mainModel')}
          </button>
          {state.workspace.activeModelPath.map((id, index) => {
            const path = state.workspace.activeModelPath.slice(0, index + 1),
              resolved = resolvePath(state.document, path);
            return (
              <span className="breadcrumb-segment" key={id}>
                <ChevronRight />
                <button
                  disabled={state.reviewBefore}
                  key={id}
                  onClick={() => {
                    enterContext(path);
                  }}
                >
                  {resolved?.instance.ref.kind === 'model'
                    ? state.document.models[resolved.instance.ref.modelId]?.name
                    : t('editor.submodel')}
                </button>
              </span>
            );
          })}
          {groupAncestors(state.document, documentSession.context.activeGroupId ?? null)
            .reverse()
            .map((group) => (
              <span className="breadcrumb-segment" key={group.id}>
                <ChevronRight />
                <button
                  disabled={state.reviewBefore}
                  onClick={() => enterContext(state.workspace.activeModelPath, group.id)}
                >
                  {group.name}
                </button>
              </span>
            ))}
        </div>
      }
      {references > 1 && (
        <div className="shared-notice">
          <span>{t('editor.shared', { count: references })}</span>
          <Button size="small" disabled={state.reviewBefore} onClick={makeContextUnique}>
            {t('editor.makeUnique')}
          </Button>
        </div>
      )}
      {(state.loading || state.error) && (
        <div className="preview-message" role="status">
          {state.error ?? t('libraryUi.previewLoading')}
        </div>
      )}
      {error && (
        <Alert
          className="viewport-error"
          type="error"
          title={t('desktop.viewport.error')}
          action={<Button onClick={() => setAttempt((v) => v + 1)}>{t('desktop.retry')}</Button>}
        />
      )}
    </section>
  );
}
