import { createElement } from 'react';
import { Alert } from 'antd';
import type { AgentResult, PublicAiError, WorkflowReport } from '@brickloop/ai';
import { i18n, useTranslation } from './store';

const knownSendCodes = [
  'PROVIDER_REQUIRED',
  'DAILY_LIMIT',
  'AI_BUSY',
  'DOCUMENT_BUSY',
  'FEATURE_DISABLED',
  'SECRET_UNREADABLE',
  'SECURE_STORAGE_UNAVAILABLE',
  'SECURE_STORAGE_FAILED',
];
export function sendFailureKey(error: unknown): string {
  // Electron invoke wraps Error.message; only extract known codes from that exception.
  const text = error instanceof Error ? error.message : String(error);
  const code = knownSendCodes.find((code) => new RegExp('\\b' + code + '\\b').test(text));
  return code ? 'aiFailure.send.' + code : 'aiUi.failed';
}
function failureTitle(error?: PublicAiError, reason?: string): string {
  if (error?.code === 'STREAM_STALLED') return i18n.t('aiFailure.stalled');
  if (error?.code === 'INSUFFICIENT_SYSTEM_RESOURCE') return i18n.t('aiFailure.resource');
  if (error?.code === 'STREAM_ABORTED') return i18n.t('aiFailure.aborted');
  if (error) return i18n.t('aiFailure.category.' + error.category);
  return reason === 'max_tokens' ? i18n.t('aiFailure.truncated') : i18n.t('aiUi.stopReasons.' + (reason ?? 'error'));
}
function failureDetails(error?: PublicAiError): string[] {
  if (!error) return [];
  return [
    ...(error.code ? [i18n.t('aiFailure.code', { value: error.code })] : []),
    ...(error.status !== undefined ? ['HTTP ' + error.status] : []),
    ...(error.finishReason ? [i18n.t('aiFailure.finishReason', { value: error.finishReason })] : []),
    ...(error.requestId ? [i18n.t('aiFailure.requestId', { value: error.requestId })] : []),
    ...(error.providerMessage
      ? [i18n.t('aiFailure.providerMessage', { value: error.providerMessage, interpolation: { escapeValue: false } })]
      : []),
    i18n.t('aiFailure.advice.' + (error.code === 'STREAM_STALLED' ? 'stalled' : error.category)),
  ];
}
export function formatAiFailure(error?: PublicAiError, reason?: string): string {
  return [failureTitle(error, reason), ...failureDetails(error)].join(' · ');
}
export function AiFailure({
  error,
  reason,
  failure,
}: {
  error?: PublicAiError | undefined;
  reason?: string | undefined;
  failure?: WorkflowReport['failure'];
}) {
  const t = useTranslation();
  const details = [
    ...(failure
      ? [
          t('aiFailure.stage.' + failure.stage, { round: failure.round ?? 0 }) +
            (failure.attempts !== undefined ? ' · ' + t('aiFailure.attempts', { count: failure.attempts }) : ''),
        ]
      : []),
    ...(reason
      ? [
          t(
            reason === 'max_tokens'
              ? 'aiFailure.truncated'
              : reason === 'error'
                ? 'aiFailure.stoppedByError'
                : 'aiUi.stopReasons.' + reason,
          ),
        ]
      : []),
    ...failureDetails(error),
  ];
  return createElement(Alert, {
    className: 'ai-failure',
    type: 'error',
    title: failureTitle(error, reason),
    description: createElement('div', {}, ...details.map((line, index) => createElement('p', { key: index }, line))),
  });
}
export function AiTurnFailure({ result }: { result: AgentResult }) {
  const t = useTranslation();
  if (result.reason === 'completed' && !result.error) return null;
  return createElement(
    'div',
    { className: 'ai-usage' },
    result.reason === 'max_tokens'
      ? createElement(
          'p',
          {},
          result.maxOutputTokens !== undefined
            ? t('aiFailure.maxTokens', { count: result.maxOutputTokens })
            : t('aiFailure.truncated'),
        )
      : null,
    result.error
      ? createElement(AiFailure, { error: result.error, reason: result.reason })
      : result.reason !== 'max_tokens'
        ? createElement('p', {}, t('aiUi.stopReasons.' + result.reason))
        : null,
  );
}
