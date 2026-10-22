import type { ModelLiveness as Liveness } from './ai-store';
import { createElement } from 'react';
import { useTranslation } from './store';

export const STREAM_STALL_NOTICE_MS = 60_000;
export function formatActivityChars(value: number): string {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + 'M';
  if (value >= 1000) return (value / 1000).toFixed(1) + 'K';
  return String(value);
}
export function ModelLiveness({
  value,
  now,
  paused = false,
  noticeMs = value?.noticeMs ?? STREAM_STALL_NOTICE_MS,
}: {
  value: Liveness | undefined;
  now: number;
  paused?: boolean;
  noticeMs?: number;
}) {
  const t = useTranslation();
  if (!value || paused) return null;
  const contentIdle = Math.max(0, now - (value.receivedAt ?? value.startedAt));
  const idle = Math.max(0, now - (value.bytesAt ?? value.receivedAt ?? value.startedAt));
  const seconds = Math.floor((idle >= noticeMs ? idle : contentIdle) / 1000);
  const warning = value.retryUntil === undefined && idle >= noticeMs;
  const keepAlive = value.bytesAt !== undefined && (value.receivedAt === null || contentIdle >= noticeMs);
  const chars = formatActivityChars(value.counts.reasoningChars + value.counts.contentChars + value.counts.toolChars);
  const text =
    value.retryUntil !== undefined
      ? t('aiFailure.retryWaiting', {
          seconds: Math.max(0, Math.ceil((value.retryUntil - now) / 1000)),
          attempt: value.retryAttempt ?? 1,
        })
      : warning
        ? t('aiUi.liveness.silent', { seconds })
        : keepAlive
          ? t('aiUi.liveness.keepAlive')
          : value.receivedAt === null
            ? t('aiUi.liveness.waiting', { seconds })
            : t('aiUi.liveness.active', { phase: t('aiUi.liveness.' + value.phase), chars, seconds });
  return createElement(
    'div',
    { className: `ai-liveness${warning ? ' is-warning' : ''}`, role: 'status', 'aria-live': 'off', title: text },
    createElement('span', { 'aria-live': 'off' }, text),
    createElement(
      'span',
      { className: 'sr-only', 'aria-live': 'polite', 'aria-atomic': true },
      warning ? t('aiUi.liveness.warningAnnouncement') : '',
    ),
  );
}
