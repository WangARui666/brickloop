import { AnimationButton } from './BuildAnimationDialog';
import { resolveConflict } from './ai-task-runtime';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Button, Segmented, Select, Switch, Tooltip } from 'antd';
import {
  ArrowRight,
  ArrowRightLeft,
  Check,
  ChevronDown,
  ChevronRight,
  CirclePlus,
  CircleMinus,
  Layers,
  List,
  Move,
  Paintbrush,
  RotateCcw,
  Undo2,
  Eye,
  TriangleAlert,
} from 'lucide-react';
import type { ChangeKind, InstanceChange, MergeConflict } from '@brickloop/core';
import type { PartId } from '@brickloop/catalog';
import { activeTab, useDocumentStore } from './document-store';
import { useReviewStore, endReview, updateReview } from './review-store';
import type { Review } from './review-store';
import { applyReview, canUndoReview, focusReview, undoReview } from './review-actions';
import { useLibraryStore } from './library-store';
import { useShellStore, useTranslation } from './store';

const order: ChangeKind[] = ['added', 'removed', 'recolored', 'replaced', 'moved', 'restepped', 'other'];
const icons = {
  added: CirclePlus,
  removed: CircleMinus,
  recolored: Paintbrush,
  replaced: ArrowRightLeft,
  moved: Move,
  restepped: Layers,
  other: Layers,
};
function useActiveReview() {
  const id = useDocumentStore((state) => state.activeId);
  return useReviewStore((state) => state.reviews[id]);
}
function ReviewActions({ compact = false, onContinue }: { compact?: boolean; onContinue?: () => void }) {
  const t = useTranslation(),
    state = useDocumentStore();
  const disabled = !!state.locked || state.reviewBefore || activeTab().readOnly;
  const undoable = canUndoReview();
  return (
    <div className="review-actions">
      <AnimationButton />
      <Button
        size="small"
        icon={<Check size={13} />}
        disabled={!!state.locked}
        onClick={() => endReview(state.activeId)}
      >
        {t('reviewUi.keep')}
      </Button>
      <Tooltip title={!undoable ? t('reviewUi.undoUnavailable') : undefined}>
        <span>
          <Button size="small" icon={<Undo2 size={13} />} disabled={disabled || !undoable} onClick={undoReview}>
            {t('reviewUi.undo')}
          </Button>
        </span>
      </Tooltip>
      {compact ? (
        <Button
          size="small"
          type="text"
          icon={<List size={14} />}
          onClick={() => {
            useShellStore.setState({ rightCollapsed: false, rightTab: 'ai' });
            requestAnimationFrame(() => document.querySelector('.ai-review')?.scrollIntoView({ block: 'nearest' }));
          }}
        >
          {t('reviewUi.details')}
        </Button>
      ) : (
        <Button size="small" type="text" disabled={disabled} onClick={onContinue}>
          {t('aiUi.continue')}
        </Button>
      )}
    </div>
  );
}
export function ReviewBar() {
  const review = useActiveReview(),
    t = useTranslation(),
    id = useDocumentStore((state) => state.activeId);
  const counts = useMemo(
    () =>
      order
        .map((kind) => ({
          kind,
          count: review?.diff.instances.filter((change) => change.kinds.includes(kind)).length ?? 0,
        }))
        .filter((item) => item.count),
    [review?.diff],
  );
  if (!review) return null;
  return (
    <>
      {review.mode === 'before' && (
        <div className="review-before-banner" role="status">
          <Eye size={14} />
          <span>{t('reviewUi.beforeBanner')}</span>
          <kbd>Esc</kbd>
          <Button size="small" type="text" onClick={() => updateReview(id, { mode: 'after' })}>
            {t('reviewUi.returnAfter')}
          </Button>
        </div>
      )}
      <div className="review-bar" role="region" aria-label={t('reviewUi.bar')} data-testid="review-bar">
        <div className="review-summary">
          {review.newIssues !== null && review.newIssues > 0 && (
            <span className="review-new-issues">{t('parallelUi.newIssues', { count: review.newIssues })}</span>
          )}
          {counts.map(({ kind, count }) => {
            const Icon = icons[kind];
            return (
              <span key={kind} className={`review-kind review-${kind}`}>
                <Icon size={13} />
                {t(`reviewUi.kinds.${kind}`)} <b>{count}</b>
              </span>
            );
          })}
          {!!review.diff.structure.length && (
            <span>
              <Layers size={13} />
              {t('reviewUi.structure')} <b>{review.diff.structure.length}</b>
            </span>
          )}
        </div>
        <div className="review-bar-controls">
          <Segmented
            size="small"
            aria-label={t('reviewUi.compare')}
            value={review.mode}
            options={[
              { value: 'before', label: t('reviewUi.before') },
              { value: 'after', label: t('reviewUi.after') },
            ]}
            onChange={(mode) => updateReview(id, { mode: mode as Review['mode'], focus: null })}
          />
          <label className="review-visibility">
            <Switch
              size="small"
              checked={review.visible}
              aria-label={t('reviewUi.annotations')}
              onChange={(visible) => updateReview(id, { visible })}
            />
            {t('reviewUi.annotations')}
          </label>
          <ReviewActions compact />
        </div>
      </div>
    </>
  );
}
function ReviewSwatch({ colorId }: { colorId: string }) {
  const colors = useLibraryStore((state) => state.allColors),
    language = useShellStore((state) => state.language);
  const color = colors.find((color) => color.id === colorId);
  return (
    <i
      className="review-swatch"
      style={{ background: color?.rgb ?? '#8a909b' }}
      title={(language === 'zh-CN' ? color?.nameZh : color?.legoName) ?? colorId}
    />
  );
}
function ReviewRow({
  change,
  review,
  names,
  disabled,
}: {
  change: InstanceChange;
  review: Review;
  names: Record<string, string>;
  disabled: boolean;
}) {
  const t = useTranslation();
  const state = review.states[change.key]!,
    instance = change.after ?? change.before!;
  const current = useDocumentStore((store) => store.document),
    target = state === 'rejected' ? change.after : change.before;
  const unavailable =
    target &&
    (!current.models[change.modelId]?.steps[target.stepId] ||
      (target.ref.kind === 'model' && !current.models[target.ref.modelId]) ||
      (target.groupId && !current.groups[target.groupId]));
  const doc = change.after ? review.after : review.before;
  const model = doc.models[change.modelId];
  const name =
    instance.ref.kind === 'part'
      ? (names[instance.ref.partId] ?? instance.ref.partId)
      : (doc.models[instance.ref.modelId]?.name ?? t('editor.submodel'));
  const Icon = icons[change.kinds[0]!];
  return (
    <div
      className={`review-row is-${state}`}
      data-review-key={change.key}
      data-review-state={state}
      onMouseEnter={() => focusReview(change.key)}
      onMouseLeave={() => updateReview(doc.documentId, { focus: null })}
    >
      <button className="review-row-main" onClick={() => focusReview(change.key, true)}>
        <Icon className={`review-${change.kinds[0]}`} size={15} />
        <strong title={name}>{name}</strong>
        <span className="review-swatches">
          {change.before && <ReviewSwatch colorId={change.before.colorId} />}
          {change.kinds.includes('recolored') && (
            <>
              <ArrowRight size={10} />
              <ReviewSwatch colorId={change.after!.colorId} />
            </>
          )}
          {!change.before && <ReviewSwatch colorId={instance.colorId} />}
        </span>
        <span className="review-row-location">
          <span
            className="review-location-text"
            title={`${model?.name} · ${t('reviewUi.stepNumber', { number: (model?.stepIds.indexOf(instance.stepId) ?? 0) + 1 })}`}
          >
            {model?.name} · {t('reviewUi.stepNumber', { number: (model?.stepIds.indexOf(instance.stepId) ?? 0) + 1 })}
          </span>
          <code className="review-tail" title={change.instanceId}>
            {change.instanceId.slice(-6)}
          </code>
          {(review.grouping !== 'type' || change.kinds.length > 1) && (
            <span className="review-row-types">
              {change.kinds.map((kind) => t(`reviewUi.kinds.${kind}`)).join(' + ')}
            </span>
          )}
          {state !== 'accepted' && <span className="review-state">{t(`reviewUi.states.${state}`)}</span>}
        </span>
      </button>
      <Tooltip
        title={
          state === 'superseded' ? t('reviewUi.supersededHint') : unavailable ? t('reviewUi.dependency') : undefined
        }
      >
        <span className="review-row-action">
          <Button
            type="text"
            size="small"
            disabled={disabled || !!unavailable || state === 'superseded'}
            onClick={() => applyReview([change.key], state === 'rejected' ? 'after' : 'before')}
          >
            {t(state === 'rejected' ? 'reviewUi.restore' : 'reviewUi.reject')}
          </Button>
        </span>
      </Tooltip>
    </div>
  );
}
function ConflictRow({
  conflict,
  review,
  names,
  disabled,
}: {
  conflict: MergeConflict;
  review: Review;
  names: Record<string, string>;
  disabled: boolean;
}) {
  const t = useTranslation();
  const resolved = review.resolvedConflicts[conflict.key];
  const instance = (resolved === 'ai' ? conflict.ai : conflict.mine) ?? conflict.ai ?? conflict.base;
  const model = conflict.modelId
    ? (review.after.models[conflict.modelId] ?? review.before.models[conflict.modelId])
    : undefined;
  const name = instance
    ? instance.ref.kind === 'part'
      ? (names[instance.ref.partId] ?? instance.ref.partId)
      : ((review.after.models[instance.ref.modelId] ?? review.before.models[instance.ref.modelId])?.name ??
        t('editor.submodel'))
    : t('reviewUi.structure');
  const stepModel = instance && model?.steps[instance.stepId] ? model : review.before.models[conflict.modelId ?? ''];
  const location = instance
    ? `${model?.name ?? review.after.meta.title} · ${t('reviewUi.stepNumber', { number: (stepModel?.stepIds.indexOf(instance.stepId) ?? 0) + 1 })}`
    : (model?.name ?? review.after.meta.title);
  return (
    <div className={`review-conflict-row${resolved ? ' is-resolved' : ''}`} data-conflict-key={conflict.key}>
      <div className="review-row-main review-conflict-main">
        <TriangleAlert size={15} />
        <strong title={name}>{name}</strong>
        {instance && <ReviewSwatch colorId={instance.colorId} />}
        <span className="review-row-location">
          <span className="review-location-text" title={location}>
            {location}
          </span>
          {conflict.instanceId && (
            <>
              <span aria-hidden="true">·</span>
              <code className="review-tail" title={conflict.instanceId}>
                {conflict.instanceId.slice(-6)}
              </code>
            </>
          )}
        </span>
      </div>
      <small>{t(`parallelUi.reasons.${conflict.reason}`)}</small>
      {resolved ? (
        <span className="review-state">{t(`parallelUi.resolved.${resolved}`)}</span>
      ) : (
        <div className="review-conflict-actions">
          <Button size="small" disabled={disabled} onClick={() => resolveConflict(conflict.key, true)}>
            {t('parallelUi.takeAi')}
          </Button>
          <Button size="small" disabled={disabled} onClick={() => resolveConflict(conflict.key, false)}>
            {t('parallelUi.keepMine')}
          </Button>
        </div>
      )}
    </div>
  );
}
export function ReviewList({ onContinue }: { onContinue: () => void }) {
  const review = useActiveReview(),
    t = useTranslation(),
    state = useDocumentStore(),
    language = useShellStore((state) => state.language);
  const [names, setNames] = useState<Record<string, string>>({});
  const groups = useMemo(() => {
    const groups = new Map<string, InstanceChange[]>();
    for (const change of review?.diff.instances ?? []) {
      const instance = change.after ?? change.before!;
      const key =
        review!.grouping === 'type'
          ? order.find((kind) => change.kinds.includes(kind))!
          : review!.grouping === 'model'
            ? change.modelId
            : `${change.modelId}/${instance.stepId}`;
      const rows = groups.get(key) ?? [];
      rows.push(change);
      groups.set(key, rows);
    }
    return [...groups].sort(([a], [b]) =>
      review?.grouping === 'type'
        ? order.indexOf(a as ChangeKind) - order.indexOf(b as ChangeKind)
        : a.localeCompare(b),
    );
  }, [review?.diff, review?.grouping]);
  useEffect(() => {
    let canceled = false;
    const ids = new Set(
      groups.flatMap(([key, rows]) =>
        rows.slice(0, review?.pages[key] ?? 200).flatMap((change) => {
          const ref = (change.after ?? change.before!).ref;
          return ref.kind === 'part' ? [ref.partId] : [];
        }),
      ),
    );
    for (const conflict of review?.conflicts.slice(0, review.pages.$conflicts ?? 200) ?? []) {
      for (const instance of [conflict.mine, conflict.ai, conflict.base]) {
        if (instance?.ref.kind === 'part') ids.add(instance.ref.partId);
      }
    }
    void Promise.all(
      [...ids].map(async (id) => {
        const part = await window.brickloop.catalogPart(id as PartId);
        return [id, part ? (language === 'zh-CN' ? part.nameZh : part.nameEn) : id] as const;
      }),
    ).then((entries) => {
      if (!canceled) setNames(Object.fromEntries(entries));
    });
    return () => {
      canceled = true;
    };
  }, [groups, review?.pages, review?.conflicts, language]);
  useLayoutEffect(() => {
    if (review && review.firstScreenMs === null)
      updateReview(state.activeId, { firstScreenMs: performance.now() - review.startedAt });
  }, [review, state.activeId]);
  if (!review) return null;
  const disabled = !!state.locked || state.reviewBefore || activeTab().readOnly;
  return (
    <div className="ai-review" role="region" aria-label={t('aiUi.review')}>
      <div className="review-list-heading">
        <strong>
          {t('reviewUi.title')} <span>{review.diff.instances.length}</span>
          {!!review.conflicts.length && (
            <>
              {' '}
              · {t('parallelUi.conflicts')} <span>{review.conflicts.length}</span>
            </>
          )}
        </strong>
        <Select
          size="small"
          aria-label={t('reviewUi.grouping')}
          value={review.grouping}
          onChange={(grouping) => updateReview(state.activeId, { grouping })}
          options={(['type', 'model', 'step'] as const).map((value) => ({
            value,
            label: t(`reviewUi.groupBy.${value}`),
          }))}
        />
      </div>
      {!!review.conflicts.length && (
        <section className="review-group review-conflicts" data-review-group="conflicts">
          <div className="review-group-heading">
            <strong>
              {t('parallelUi.conflicts')} · {review.conflicts.length}
            </strong>
          </div>
          {review.conflicts.slice(0, review.pages.$conflicts ?? 200).map((conflict) => (
            <ConflictRow key={conflict.key} conflict={conflict} review={review} names={names} disabled={disabled} />
          ))}
          {review.conflicts.length > (review.pages.$conflicts ?? 200) && (
            <Button
              size="small"
              type="text"
              className="review-more"
              onClick={() =>
                updateReview(state.activeId, {
                  pages: { ...review.pages, $conflicts: (review.pages.$conflicts ?? 200) + 200 },
                })
              }
            >
              {t('reviewUi.more')}
            </Button>
          )}
        </section>
      )}
      {groups.map(([key, rows]) => {
        const first = rows[0]!,
          instance = first.after ?? first.before!,
          doc = first.after ? review.after : review.before,
          model = doc.models[first.modelId];
        const label =
          review.grouping === 'type'
            ? t(`reviewUi.kinds.${key}`)
            : review.grouping === 'model'
              ? model?.name
              : `${model?.name} · ${t('reviewUi.stepNumber', { number: (model?.stepIds.indexOf(instance.stepId) ?? 0) + 1 })}`;
        const rejected = rows.every((change) => review.states[change.key] === 'rejected'),
          blocked = rows.some((change) => review.states[change.key] === 'superseded');
        const collapsed = review.collapsed[key] ?? false,
          count = review.pages[key] ?? 200;
        return (
          <section className="review-group" key={key} data-review-group={key}>
            <div className="review-group-heading">
              <button
                aria-expanded={!collapsed}
                onClick={() => updateReview(state.activeId, { collapsed: { ...review.collapsed, [key]: !collapsed } })}
              >
                {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                <span>{label}</span>
                <b>{rows.length}</b>
              </button>
              <Button
                size="small"
                type="text"
                disabled={disabled || blocked}
                onClick={() =>
                  applyReview(
                    rows.map((change) => change.key),
                    rejected ? 'after' : 'before',
                  )
                }
              >
                {t(rejected ? 'reviewUi.restoreGroup' : 'reviewUi.rejectGroup')}
              </Button>
            </div>
            {!collapsed && (
              <>
                {rows.slice(0, count).map((change) => (
                  <ReviewRow key={change.key} change={change} review={review} names={names} disabled={disabled} />
                ))}
                {rows.length > count && (
                  <Button
                    size="small"
                    type="text"
                    className="review-more"
                    onClick={() => updateReview(state.activeId, { pages: { ...review.pages, [key]: count + 200 } })}
                  >
                    {t('reviewUi.more')}
                  </Button>
                )}
              </>
            )}
          </section>
        );
      })}
      {!!review.diff.structure.length && (
        <details className="review-structure">
          <summary>
            <Layers size={13} />
            {t('reviewUi.structure')} <b>{review.diff.structure.length}</b>
            <span>{t('reviewUi.readonly')}</span>
          </summary>
          <p>{t('reviewUi.structureHint')}</p>
          {review.diff.structure.slice(0, review.pages.$structure ?? 200).map((change, index) => (
            <div key={`${change.kind}/${change.id}/${index}`}>
              <span>{t(`reviewUi.structureKinds.${change.kind}`)}</span>
              <span>
                {change.name ??
                  (() => {
                    const [modelId, stepId] = change.id.split('/');
                    const model = review.after.models[modelId!] ?? review.before.models[modelId!];
                    if (model && stepId) {
                      const position = (
                        review.after.models[modelId!]?.stepIds.includes(stepId) ? review.after : review.before
                      ).models[modelId!]!.stepIds.indexOf(stepId);
                      return `${model.name} · ${t('reviewUi.stepNumber', { number: position + 1 })}`;
                    }
                    return model?.name ?? review.after.meta.title;
                  })()}
              </span>
            </div>
          ))}
          {review.diff.structure.length > (review.pages.$structure ?? 200) && (
            <Button
              type="text"
              size="small"
              onClick={() =>
                updateReview(state.activeId, {
                  pages: { ...review.pages, $structure: (review.pages.$structure ?? 200) + 200 },
                })
              }
            >
              {t('reviewUi.more')}
            </Button>
          )}
        </details>
      )}
      {!canUndoReview() && (
        <p className="review-history-hint">
          <RotateCcw size={12} />
          {t(review.transactionId ? 'reviewUi.undoUnavailable' : 'parallelUi.conflictOnly')}
        </p>
      )}
      <ReviewActions onContinue={onContinue} />
    </div>
  );
}
