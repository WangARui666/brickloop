import { createI18n } from '@brickloop/i18n';
import type { WorkflowReport } from './types.js';
const i18n = createI18n({ language: 'zh-CN' });
export function summarizeImageModelReport(report: Omit<WorkflowReport, 'summaryZh'>): string {
  const unknown = i18n.t('imageModel.report.unknown');
  return [
    i18n.t('imageModel.report.result', { reason: i18n.t('imageModel.stop.' + report.reason) }),
    ...(report.failure
      ? [
          [
            i18n.t('imageModel.report.failure'),
            i18n.t('aiFailure.stage.' + report.failure.stage, { round: report.failure.round ?? 0 }),
            report.failure.error
              ? i18n.t('aiFailure.category.' + report.failure.error.category)
              : i18n.t(
                  report.failure.agentReason === 'max_tokens'
                    ? 'aiFailure.truncated'
                    : 'aiUi.stopReasons.' + (report.failure.agentReason ?? 'error'),
                ),
            report.failure.error?.status !== undefined ? 'HTTP ' + report.failure.error.status : '',
            report.failure.error?.code,
            report.failure.error?.finishReason,
            report.failure.error?.requestId,
            report.failure.error?.providerMessage,
            ...(report.failure.error?.code === 'STREAM_STALLED'
              ? [i18n.t('aiFailure.stalled'), i18n.t('aiFailure.advice.stalled')]
              : []),
            report.failure.attempts !== undefined
              ? i18n.t('aiFailure.attempts', { count: report.failure.attempts })
              : '',
          ]
            .filter(Boolean)
            .join(' · '),
        ]
      : []),
    i18n.t('imageModel.report.rounds', { count: report.rounds?.length ?? 0 }),
    ...(report.rounds ?? []).map((r) =>
      i18n.t('imageModel.report.round', { round: r.round, parts: r.partCount, issues: r.issues.length }),
    ),
    ...(report.buildabilitySkipped ? [i18n.t('imageUi.buildabilitySkipped')] : []),
    i18n.t('imageModel.report.counts', { parts: report.partCount ?? unknown, colors: report.colorCount ?? unknown }),
    i18n.t('imageModel.report.validation', {
      result: !report.validation.checked
        ? i18n.t('imageModel.report.unchecked')
        : report.validation.issues.length
          ? i18n.t('imageModel.report.issues', { count: report.validation.issues.length })
          : i18n.t('imageModel.report.valid'),
    }),
    i18n.t('imageModel.report.budget', { calls: report.toolCalls, seconds: Math.round(report.elapsedMs / 1000) }),
    ...(!report.references.some((r) => r.view) ? [i18n.t('imageModel.report.noComparableViews')] : []),
    ...report.references.map((ref) =>
      ref.source === 'excluded'
        ? [ref.name, i18n.t('imageModel.viewSource.excluded'), i18n.t('imageModel.report.notCalculated')].join(' · ')
        : i18n.t('imageModel.report.reference', {
            name: ref.name,
            view: ref.view ? i18n.t('imageModel.views.' + ref.view) : i18n.t('imageModel.views.none'),
            source: i18n.t('imageModel.viewSource.' + ref.source, { confidence: ref.confidence?.toFixed(2) ?? '' }),
            iou: ref.iou === null ? i18n.t('imageModel.report.notCalculated') : (ref.iou * 100).toFixed(1) + '%',
          }),
    ),
    ...report.comparisons.map(
      (c) =>
        i18n.t(c.componentId === null ? 'imageUi.wholeRound' : 'imageUi.componentRound', {
          name: report.plan?.components.find((p) => p.id === c.componentId)?.name ?? '',
          round: c.round,
        }) +
        ' · ' +
        i18n.t('imageModel.report.view', {
          view: i18n.t('imageModel.views.' + c.view),
          round: c.round,
          iou: (c.iou * 100).toFixed(1),
        }) +
        (c.inferredView
          ? ' · ' + i18n.t('imageModel.viewSource.ai', { confidence: c.confidence?.toFixed(2) ?? '' })
          : ''),
    ),
    ...(report.unfinished.length
      ? [
          i18n.t('imageModel.report.unfinished', {
            items: report.unfinished
              .map(
                (item) =>
                  i18n.t('imageModel.unfinished.' + item.code) +
                  (item.componentId
                    ? '（' +
                      (report.plan?.components.find((c) => c.id === item.componentId)?.name ?? item.componentId) +
                      '）'
                    : ''),
              )
              .join('；'),
          }),
        ]
      : []),
  ].join('\n');
}
