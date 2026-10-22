import { AiFailure } from './ai-failure';
import { AnimationButton } from './BuildAnimationDialog';
import { useEffect, useState } from 'react';
import { Button, Input, Progress } from 'antd';
import { Pause, Play, Square, Download } from 'lucide-react';
import type { WorkflowReport, ViewComparison, WorkflowRound } from '@brickloop/ai';
import { useTaskStore } from './ai-task-runtime';
import { useAiStore } from './ai-store';
import { ModelLiveness } from './ModelLiveness';
import { useTranslation } from './store';
import { AiImages } from './AiImages';
import { useProjectUi } from './project-controller';

export function Comparison({
  comparison,
  componentName,
}: {
  comparison: ViewComparison;
  componentName?: string | undefined;
}) {
  const t = useTranslation();
  return (
    <figure className="image-comparison" data-component={comparison.componentId ?? 'whole'}>
      <AiImages images={comparison.images.slice(0, 2)} comparison />
      <figcaption>
        <div>
          {t(comparison.componentId === null ? 'imageUi.wholeRound' : 'imageUi.componentRound', {
            round: comparison.round,
            name: componentName ?? '',
          })}
        </div>
        {t('imageUi.wholePreview')} · {t(`imageModel.views.${comparison.view}`)} ·{' '}
        {t('imageUi.iou', { value: (comparison.iou * 100).toFixed(1) })}
        {comparison.inferredView && <span> · {t('imageUi.inferredView')}</span>}
        {comparison.emptyModel && <div>{t('aiToolErrors.emptyForeground')}</div>}
      </figcaption>
    </figure>
  );
}
export function ImageTaskPanel() {
  const t = useTranslation(),
    workflow = useAiStore((s) => s.workflow),
    liveness = useAiStore((s) => (workflow ? s.liveness[workflow.taskId] : undefined)),
    tasks = useTaskStore((s) => s.tasks);
  const running = !!workflow && tasks[workflow.taskId]?.status === 'running';
  const [interjection, setInterjection] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (!workflow || !running) return null;
  const { state, request, plan, comparison } = workflow;
  const elapsed = (state?.elapsedMs ?? 0) + (state?.paused ? 0 : Math.max(0, now - workflow.updatedAt));
  const phase = state?.phase ?? 'understanding';
  const progress =
    phase === 'understanding'
      ? 4
      : phase === 'preparing'
        ? 8
        : Math.min(98, 10 + (88 * (state?.round ?? 0)) / (request.budget.rounds ?? 8));
  return (
    <section className="image-task-card" aria-label={t('imageUi.task')} data-phase={phase}>
      <div className="image-task-heading">
        <strong>
          {t(`imageUi.phase.${phase}`, { round: state?.round ?? 0 })}
          {(state?.round ?? 0) > 0 && (
            <span className="secondary">
              {' '}
              · {t('imageUi.roundProgress', { round: state?.round ?? 0, total: request.budget.rounds ?? 8 })}
            </span>
          )}
        </strong>
        <span>{state?.paused ? t('imageUi.paused') : ''}</span>
      </div>
      <Progress percent={Math.round(progress)} showInfo={false} size="small" />
      <div className="image-task-budget">
        <span>{t('imageUi.calls', { used: state?.toolCalls ?? 0, total: request.budget.toolCalls })}</span>
        <span>{t('imageUi.time', { used: Math.floor(elapsed / 1000), total: request.budget.durationMs / 60000 })}</span>
        <ModelLiveness value={liveness} now={now} paused={!!state?.paused || !!state?.awaitingConfirmation} />
      </div>
      {comparison && (
        <Comparison
          comparison={comparison}
          componentName={plan?.components.find((c) => c.id === comparison.componentId)?.name}
        />
      )}
      <RoundTimeline rounds={workflow.rounds ?? []} />
      <ScriptSource script={workflow.script ?? null} />
      <div className="image-task-actions">
        <Button
          size="small"
          icon={state?.paused ? <Play /> : <Pause />}
          onClick={() =>
            void window.brickloop.aiImageControl(state?.paused ? 'resume' : 'pause', undefined, workflow.taskId)
          }
        >
          {t(state?.paused ? 'imageUi.resume' : 'imageUi.pause')}
        </Button>
        <Button size="small" icon={<Square />} onClick={() => void window.brickloop.aiStop(workflow.taskId)}>
          {t('aiUi.stop')}
        </Button>
        <Input
          size="small"
          aria-label={t('imageUi.interject')}
          value={interjection}
          placeholder={t('imageUi.interjectPlaceholder')}
          onChange={(e) => setInterjection(e.target.value)}
          onPressEnter={() => {
            if (interjection.trim()) void window.brickloop.aiImageControl('interject', interjection, workflow.taskId);
            setInterjection('');
          }}
        />
      </div>
    </section>
  );
}
export function ImageReport({ report }: { report: WorkflowReport }) {
  const t = useTranslation();
  const comparisons = report.comparisons;
  // Reports saved in older project histories do not have per-reference view sources.
  const references = report.references ?? [];
  const latest = [...new Map(comparisons.map((c) => [c.referenceId, c])).values()];
  return (
    <section className="image-report" aria-label={t('imageUi.report')}>
      <div className="image-task-heading">
        <strong>{t('imageUi.report')}</strong>
        <span className="secondary">{t(`imageModel.stop.${report.reason}`)}</span>
      </div>
      {report.failure && (
        <AiFailure failure={report.failure} error={report.failure.error} reason={report.failure.agentReason} />
      )}
      <div className="image-report-counts">
        <span>
          {report.partCount === null
            ? t('imageUi.partCountUnknown')
            : t('imageUi.partCount', { count: report.partCount })}
        </span>
        <span>
          {report.colorCount === null
            ? t('imageUi.colorCountUnknown')
            : t('imageUi.colorCount', { count: report.colorCount })}
        </span>
      </div>
      <p>{t('imageUi.roundCount', { count: report.rounds?.length ?? 0 })}</p>
      {report.buildabilitySkipped && <p className="secondary">{t('imageUi.buildabilitySkipped')}</p>}
      <RoundTimeline rounds={report.rounds ?? []} />
      <ScriptSource script={report.script ?? null} />
      <div className="image-validation">
        {(['collision', 'floating', 'non_factory_part'] as const).map((kind) => {
          const count = report.validation.issues.filter((i) => i.kind === kind).length;
          return (
            <div key={kind}>
              <span>{t(`aiIssues.${kind}`)}</span>
              <span className={report.validation.checked && count === 0 ? 'check-pass' : ''}>
                {!report.validation.checked ? t('imageModel.report.unchecked') : count || t('imageUi.passed')}
              </span>
            </div>
          );
        })}
      </div>
      {report.validation.issues.some((i) => !['collision', 'floating', 'non_factory_part'].includes(i.kind)) && (
        <p>
          {t('imageUi.otherIssues', {
            count: report.validation.issues.filter(
              (i) => !['collision', 'floating', 'non_factory_part'].includes(i.kind),
            ).length,
          })}
        </p>
      )}
      {report.references && !references.some((r) => r.view) && <p>{t('imageModel.report.noComparableViews')}</p>}
      {!!references.length && (
        <ul className="image-reference-report">
          {references.map((ref) => (
            <li key={ref.referenceId}>
              <strong>{ref.name}</strong>
              <span>{t(`imageModel.viewSource.${ref.source}`, { confidence: ref.confidence?.toFixed(2) ?? '' })}</span>
              <span>
                {ref.view && <>{t(`imageModel.views.${ref.view}`)} · </>}
                {ref.iou === null
                  ? t('imageModel.report.notCalculated')
                  : t('imageUi.iou', { value: (ref.iou * 100).toFixed(1) })}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!!comparisons.length && (
        <details className="image-comparison-history">
          <summary>{t('imageUi.comparisonHistory', { count: comparisons.length })}</summary>
          {comparisons.map((c, index) => (
            <Comparison
              key={index}
              comparison={c}
              componentName={report.plan?.components.find((p) => p.id === c.componentId)?.name}
            />
          ))}
        </details>
      )}
      {latest.map((comparison) => (
        <Comparison
          key={comparison.referenceId}
          comparison={comparison}
          componentName={report.plan?.components.find((p) => p.id === comparison.componentId)?.name}
        />
      ))}
      {!comparisons.length && !!report.latestRender.length && <AiImages images={report.latestRender} />}
      <div className="image-unfinished-title">
        <strong>{t('imageUi.unfinished')}</strong>
        {!report.unfinished.length && <span>{t('imageUi.none')}</span>}
      </div>
      {report.unfinished.length ? (
        <ul>
          {report.unfinished.map((item, index) => (
            <li key={index}>
              {t(`imageModel.unfinished.${item.code}`)}
              {item.componentId
                ? ` · ${report.plan?.components.find((c) => c.id === item.componentId)?.name ?? ''}`
                : ''}
            </li>
          ))}
        </ul>
      ) : null}
      <AnimationButton />
      <Button icon={<Download />} onClick={() => useProjectUi.setState({ exportFormat: 'io' })}>
        {t('imageUi.export')}
      </Button>
    </section>
  );
}

function ScriptSource({ script }: { script: WorkflowReport['script'] }) {
  const t = useTranslation();
  return script ? (
    <details className="image-script-source">
      <summary>{t('imageUi.viewScript')}</summary>
      <pre>{script.code}</pre>
    </details>
  ) : null;
}
function RoundTimeline({ rounds }: { rounds: WorkflowRound[] }) {
  const t = useTranslation();
  if (!rounds.length) return null;
  return (
    <ol className="image-round-timeline" aria-label={t('imageUi.timeline')}>
      {rounds.map((r) => (
        <li key={r.round} data-round={r.round}>
          <details key={`${r.round}-${rounds.length}`} open={r.round === rounds.at(-1)?.round}>
            <summary className="image-round-title">
              <strong>{t('imageUi.wholeRound', { round: r.round })}</strong>
              <span>{t(`imageUi.phase.${r.phase}`, { round: r.round })}</span>
            </summary>
            <AiImages images={r.images.slice(0, 2)} />
            <div className="image-round-metrics">
              <span>{t('imageUi.partCount', { count: r.partCount })}</span>
              <span>{t('imageUi.roundIssues', { count: r.issues.length })}</span>
            </div>
            {r.comparisons.map((c) => (
              <small key={c.referenceId}>
                {t(`imageModel.views.${c.view}`)} · {t('imageUi.iou', { value: (c.iou * 100).toFixed(1) })}
                {c.inferredView ? ' · ' + t('imageUi.inferredView') : ''}
              </small>
            ))}
            {!r.comparisons.length && <small>{t('imageModel.report.notCalculated')}</small>}
            {r.warnings.map((warning) => (
              <small key={warning}>
                {t(
                  ['output_truncated_retried', 'transient_retry'].includes(warning)
                    ? 'aiFailure.warnings.' + warning
                    : 'imageUi.roundWarnings.' + warning,
                )}
              </small>
            ))}
          </details>
        </li>
      ))}
    </ol>
  );
}
