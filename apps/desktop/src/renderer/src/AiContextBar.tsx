import { useEffect, useState } from 'react';
import { Button, Modal, Tooltip } from 'antd';
import { MessageSquarePlus } from 'lucide-react';
import { presetCapabilities } from '@brickloop/ai';
import { aiChoice, useAiStore } from './ai-store';
import { useTaskStore } from './ai-task-runtime';
import { activeTab, useDocumentStore } from './document-store';
import { useShellStore, useTranslation } from './store';
import { documentTurns, readContextMarks, startNewConversation } from './ai-integration';
import { useContextAnalysis } from './ai-context-refresh';
import { contextHistory, contextTurns, formatContextTokens } from './ai-context';
import type { estimateContext } from './ai-context';
import { createModuleWorker } from './module-worker';
import workerUrl from './ai-context.worker?worker&url';

type Estimate = { usage: ReturnType<typeof estimateContext>; calculationMs: number; totalMs: number };
export function AiContextBar({ modelContext, draft }: { modelContext: boolean; draft: string }) {
  const t = useTranslation();
  const allTurns = useAiStore((state) => state.turns);
  const snapshot = useAiStore((state) => state.snapshot);
  const choice = aiChoice(useAiStore());
  const catalogCapabilities = snapshot?.modelCapabilities?.[choice.provider?.id ?? '']?.[choice.model];
  const tasks = useTaskStore((state) => state.tasks);
  const document = useDocumentStore();
  const visible = useShellStore((state) => !state.rightCollapsed && state.rightTab === 'ai');
  const tab = activeTab();
  const marks = readContextMarks(tab);
  const turns = tab ? documentTurns(tab) : [];
  const included = contextTurns(turns, marks, tasks);
  const lastCompressed =
    !!included.at(-1)?.compressed ||
    !!marks.checkpoint?.coveredTurnIds.every((id, index) => included[index]?.id === id);
  const busy = Object.values(tasks).some(
    (task) => task.documentId === document.activeId && ['queued', 'running'].includes(task.status),
  );
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const anyBusy = Object.values(tasks).some((task) => ['queued', 'running'].includes(task.status));
  const { analysis, stats } = useContextAnalysis(visible && !!tab, anyBusy, document.document.documentId);
  const path = JSON.stringify(document.workspace.activeModelPath);

  // Typing postpones the snapshot handoff until an idle pause. Draft text is never
  // passed to either Worker or included in the next-request context count.
  useEffect(() => {
    if (!visible || !analysis) return;
    let cancelled = false,
      idle: number | undefined,
      worker: Worker | undefined;
    const timer = window.setTimeout(() => {
      idle = requestIdleCallback(
        () => {
          const started = performance.now();
          const tab = activeTab();
          if (cancelled || !tab) return;
          // The context path can change without changing the document revision.
          worker = createModuleWorker(workerUrl);
          worker.onmessage = (event: MessageEvent<Omit<Estimate, 'totalMs'>>) => {
            if (!cancelled) setEstimate({ ...event.data, totalMs: performance.now() - started });
            worker?.terminate();
          };
          worker.onerror = () => {
            worker?.terminate();
            if (!cancelled) setEstimate(null);
          };
          worker.postMessage({
            analysis,
            activeModelPath: tab.session.context.activeModelPath,
            modelContext,
            history: contextHistory(documentTurns(tab), readContextMarks(tab), useTaskStore.getState().tasks),
            capabilities: catalogCapabilities ?? presetCapabilities(choice.provider?.presetId, choice.model),
          });
        },
        { timeout: 1000 },
      );
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (idle !== undefined) cancelIdleCallback(idle);
      worker?.terminate();
    };
  }, [
    allTurns,
    marks,
    tasks,
    choice.provider,
    choice.model,
    catalogCapabilities,
    analysis,
    path,
    modelContext,
    visible,
    draft,
  ]);

  const usage = estimate?.usage;
  const disabledReason = busy ? 'aiContext.busy' : !included.length ? 'aiContext.empty' : '';
  const details = usage ? (
    <div className="ai-context-details">
      <p>{t('aiContext.base', { tokens: formatContextTokens(usage.baseTokens) })}</p>
      <p>{t('aiContext.history', { tokens: formatContextTokens(usage.historyTokens) })}</p>
      {included.length > 0 && presetCapabilities(choice.provider?.presetId, choice.model).reasoningReplay && (
        <p>{t('aiContext.reasoningReplay')}</p>
      )}
      <p>{t(usage.window === null ? 'aiContext.compressionUnknown' : 'aiContext.compressionHelp')}</p>
      <p>{t(lastCompressed ? 'aiContext.lastCompressed' : 'aiContext.lastNotCompressed')}</p>
      <p>{t('aiContext.counts', { included: included.length, excluded: turns.length - included.length })}</p>
    </div>
  ) : (
    t('aiContext.calculating')
  );
  return (
    <div
      className="ai-context-bar"
      data-testid="ai-context-bar"
      data-tokens={usage?.tokens}
      data-calculation-ms={estimate?.calculationMs}
      data-total-ms={estimate?.totalMs}
      data-analysis-count={stats?.count ?? 0}
      data-analysis-ms={stats?.totalMs ?? 0}
    >
      <div className="ai-context-line">
        <Tooltip title={details}>
          <span className="ai-context-usage" tabIndex={0}>
            {usage
              ? t(usage.window === null ? 'aiContext.unknown' : 'aiContext.known', {
                  tokens: formatContextTokens(usage.tokens),
                  window: formatContextTokens(usage.window ?? 0),
                  percent: Math.round((usage.tokens / (usage.window ?? 1)) * 100),
                  count: included.length,
                })
              : t('aiContext.calculating')}
          </span>
        </Tooltip>
        <Tooltip title={disabledReason ? t(disabledReason) : undefined}>
          <span>
            <Button
              size="small"
              type="text"
              icon={<MessageSquarePlus size={16} />}
              disabled={!!disabledReason}
              onClick={() => setConfirmId(document.activeId)}
            >
              {t('aiContext.new')}
            </Button>
          </span>
        </Tooltip>
      </div>
      {usage?.window !== null && usage?.window !== undefined && (
        <div
          className="ai-context-progress"
          role="progressbar"
          aria-label={t('aiContext.progress')}
          aria-valuemin={0}
          aria-valuemax={usage.window}
          aria-valuenow={Math.min(usage.tokens, usage.window)}
        >
          <span style={{ width: `${Math.min(100, (usage.tokens / usage.window) * 100)}%` }} />
        </div>
      )}
      {(lastCompressed || usage?.summarized) && (
        <div className="ai-context-compression">
          {lastCompressed && <span>{t('aiContext.compressed')}</span>}
          {usage?.summarized && <span>{t('aiContext.willCompress')}</span>}
        </div>
      )}
      <Modal
        open={confirmId !== null}
        title={t('aiContext.confirmTitle')}
        okText={t('aiContext.confirm')}
        cancelText={t('aiContext.cancel')}
        onCancel={() => setConfirmId(null)}
        okButtonProps={{ disabled: busy || !included.length || confirmId !== document.activeId }}
        onOk={() => {
          if (confirmId) startNewConversation(confirmId);
          setConfirmId(null);
        }}
      >
        <p>{t('aiContext.confirmBody')}</p>
      </Modal>
    </div>
  );
}
