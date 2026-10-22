import { useEffect, useState } from 'react';
import { Button, Tag, Tooltip } from 'antd';
import { Eye, Square, GitMerge, Trash2 } from 'lucide-react';
import type { SavedTurn } from '../../shared/ai-api';
import { previewTask, useTaskStore } from './ai-task-runtime';
import { useTranslation } from './store';
import { formatUsd } from './ai-format';
import { useAiStore } from './ai-store';
import { ModelLiveness } from './ModelLiveness';
import { turnContextStatus } from './ai-context';
import { readContextMarks } from './ai-integration';
import { documentTabs } from './document-store';
export function AiTaskCard({ turn }: { turn: SavedTurn }) {
  const t = useTranslation(),
    task = useTaskStore((s) => s.tasks[turn.id]),
    preview = useTaskStore((s) => s.previewId);
  const workflow = useAiStore((s) => s.workflows[turn.id]);
  const liveness = useAiStore((s) => s.liveness[turn.id]);
  const [now, setNow] = useState(Date.now());
  const running = task?.status === 'running',
    queued = task?.status === 'queued',
    pending = task?.status === 'pending_merge';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const cost = turn.result?.cost ?? turn.cost;
  const usage = turn.result?.usage ?? turn.usage;
  const title = turn.user.split(/\r?\n/)[0] || t('aiUi.reference');
  const tab = turn.documentId ? documentTabs.get(turn.documentId) : undefined;
  const context = tab ? turnContextStatus(turn, readContextMarks(tab)) : undefined;
  if (!task && !cost) return null;
  const call = (action: 'merge' | 'discard') =>
    void window.brickloop
      .aiTaskAction(turn.id, action)
      .catch(() => useAiStore.setState({ error: 'parallelUi.invalidMerge' }));
  return (
    <div className="ai-task-heading" data-task-state={task?.status}>
      {!running && !queued && context?.included && context.summary && (
        <Tag className="ai-context-summarized">{t('aiContext.includedSummary')}</Tag>
      )}
      {task && (
        <div className="ai-task-header-row">
          <Tag className={`ai-task-state task-${task.status}`}>{t(`parallelUi.status.${task.status}`)}</Tag>
          <strong className="ai-task-title" title={title}>
            {title}
          </strong>
          <div className="ai-task-actions">
            {(running || queued) && (
              <Button size="small" icon={<Square size={12} />} onClick={() => void window.brickloop.aiStop(turn.id)}>
                {t('aiUi.stop')}
              </Button>
            )}
            {(running || pending) && (
              <Button
                size="small"
                className={preview === turn.id ? 'ai-task-preview is-active' : 'ai-task-preview'}
                icon={<Eye size={12} />}
                aria-pressed={preview === turn.id}
                onClick={() => previewTask(preview === turn.id ? null : turn.id)}
              >
                {t('parallelUi.preview')}
              </Button>
            )}
            {pending && (
              <>
                <Button size="small" icon={<GitMerge size={12} />} onClick={() => call('merge')}>
                  {t('parallelUi.merge')}
                </Button>
                <Button size="small" type="text" icon={<Trash2 size={12} />} onClick={() => call('discard')}>
                  {t('parallelUi.discard')}
                </Button>
              </>
            )}
          </div>
        </div>
      )}
      <div className="ai-task-meta">
        {task && (
          <>
            <span>
              {t('parallelUi.progress', {
                calls: turn.events.filter((e) => e.type === 'tool_call').length,
                seconds: Math.max(
                  0,
                  Math.floor(
                    (turn.report?.elapsedMs ??
                      (workflow?.state
                        ? workflow.state.elapsedMs +
                          (workflow.state.paused || workflow.state.phase === 'finished'
                            ? 0
                            : Math.max(0, now - workflow.updatedAt))
                        : (task.endedAt ?? now) - (task.startedAt ?? task.createdAt))) / 1000,
                  ),
                ),
              })}
            </span>
            <span aria-hidden="true">·</span>
          </>
        )}
        <Tooltip title={usage ? t('aiUi.usage', { input: usage.inputTokens, output: usage.outputTokens }) : undefined}>
          <span className="ai-task-cost" tabIndex={usage ? 0 : undefined}>
            {cost?.amount != null
              ? t('aiUi.cost', { amount: formatUsd(cost.amount) })
              : t(cost?.label === '使用套餐额度' ? 'aiUi.plan' : 'aiUi.unpriced')}
          </span>
        </Tooltip>
        {running && task.kind !== 'image' && <ModelLiveness value={liveness} now={now} />}
      </div>
      {pending && task?.summary && <div className="ai-merge-summary">{t('parallelUi.summary', task.summary)}</div>}
      {task?.error && <div className="check-error">{t(task.error)}</div>}
    </div>
  );
}
