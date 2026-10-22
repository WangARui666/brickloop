import { usePreferences } from './preferences-store';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Image, Input, InputNumber, Modal, Radio, Select, Tooltip } from 'antd';
import { ImagePlus, X, Plus, Trash2, GripVertical, ArrowUp, ArrowDown } from 'lucide-react';
import {
  structurePlanIssues,
  designCategories,
  standardReferenceViews,
  planningReferenceId,
  isStandardReferenceView,
} from '@brickloop/ai';
import type { ReferenceView, StructurePlan } from '@brickloop/ai';
import type { ImageTaskRequest } from '../../shared/ai-api';
import { useAiStore, startImageTask } from './ai-store';
import { useLibraryStore } from './library-store';
import { documentLocked } from './document-store';
import { useShellStore, useTranslation } from './store';
import { imageSource, readImageFiles } from './AiImages';
import { formatBoxCorner } from './plan-format';

let initialImages: ImageTaskRequest['input']['images'] | undefined;

export function openImageInput(): boolean;
export function openImageInput(images: ImageTaskRequest['input']['images']): boolean;
export function openImageInput(images?: ImageTaskRequest['input']['images']) {
  if (documentLocked()) return false;
  // The menu also uses this function directly as its click handler.
  initialImages = Array.isArray(images) && images.length ? images : undefined;
  useShellStore.setState({ rightCollapsed: false, rightTab: 'ai', rightWidth: 380 });
  useAiStore.setState({ imageInputOpen: true });
  return true;
}
export function ImageModelDialogs() {
  const t = useTranslation(),
    state = useAiStore(),
    library = useLibraryStore(),
    language = useShellStore((s) => s.language);
  const [images, setImages] = useState<ImageTaskRequest['input']['images']>([]),
    [viewMode, setViewMode] = useState<'auto' | 'fixed'>('auto'),
    [description, setDescription] = useState(''),
    [style, setStyle] = useState('');
  const [size, setSize] = useState('medium'),
    [dimensions, setDimensions] = useState<{ width?: number; depth?: number; height?: number }>({ width: 16 });
  const [palette, setPalette] = useState<'factory' | 'project' | 'custom'>('factory'),
    [colorIds, setColorIds] = useState<string[]>([]);
  const [parts, setParts] = useState<'factory' | 'categories' | 'all'>('all'),
    [categories, setCategories] = useState<string[]>([]);
  const [rounds, setRounds] = useState(20),
    [priority, setPriority] = useState<'appearance' | 'buildable'>('buildable');
  const [calls, setCalls] = useState(2000),
    [minutes, setMinutes] = useState(120),
    [direct, setDirect] = useState(false),
    [error, setError] = useState('');
  const [plan, setPlan] = useState<StructurePlan | null>(null),
    [dragged, setDragged] = useState<string | null>(null);
  useEffect(() => {
    if (state.imageInputOpen && initialImages) {
      setImages(initialImages);
      setViewMode('auto');
      setError('');
      initialImages = undefined;
    }
  }, [state.imageInputOpen]);
  const sourcePlan = state.workflow?.plan;
  const planForm = useRef<HTMLDivElement>(null);
  const planRows = useRef(new Map<string, HTMLTableRowElement>());
  useEffect(() => {
    setPlan(sourcePlan ? structuredClone(sourcePlan) : null);
  }, [sourcePlan]);
  const providers = state.snapshot?.settings.providers ?? [];
  const vision = state.snapshot?.settings.defaults.vision ?? '',
    visionId = vision.split('/')[0];
  const provider =
    providers.find((p) => p.id === state.selectedProvider) ??
    providers.find((p) => p.id === visionId) ??
    providers.find((p) => p.id === state.snapshot?.settings.defaultProviderId) ??
    providers[0];
  const model =
    state.selectedModel ||
    (provider?.id === visionId ? vision.slice(visionId!.length + 1) : '') ||
    provider?.model ||
    '';
  const colors = library.colors.map((c) => ({
    value: c.id,
    label: (
      <span className="image-color-option">
        <i style={{ backgroundColor: c.rgb }} />
        {language === 'en' ? c.legoName : c.nameZh}
      </span>
    ),
  }));
  const review = sourcePlan?.colorReview;
  const boxRepairs = state.workflow?.boxRepairs ?? [];
  const colorRepairs = review?.repairs ?? [];
  const paletteColorIds = review?.paletteColorIds ?? library.colors.map((c) => c.id);
  const planColors = library.allColors
    .filter((c) => paletteColorIds.includes(c.id))
    .map((c) => ({
      value: c.id,
      label: (
        <span className="image-color-option">
          <i style={{ backgroundColor: c.rgb }} />
          {language === 'en' ? c.legoName : c.nameZh}
        </span>
      ),
    }));
  const colorName = (id: string) => {
    const color = library.allColors.find((c) => c.id === id);
    return color ? ((language === 'en' ? color.legoName : color.nameZh) ?? id) : id;
  };
  async function attach(files: FileList | File[]) {
    try {
      const added = await readImageFiles(files, 8 - images.length);
      setImages((before) => [...before, ...added.map((v) => ({ ...v, view: 'auto' as const }))].slice(0, 8));
      setError('');
    } catch {
      setError('aiUi.imageSize');
    }
  }
  function editRow(id: string, update: Partial<StructurePlan['components'][number]>) {
    setPlan((p) => (p ? { ...p, components: p.components.map((c) => (c.id === id ? { ...c, ...update } : c)) } : null));
  }
  function reorder(id: string, to: number) {
    setPlan((p) => {
      if (!p) return p;
      const order = p.buildOrder.filter((v) => v !== id);
      order.splice(Math.max(0, Math.min(to, order.length)), 0, id);
      return { ...p, buildOrder: order };
    });
  }
  const planIssues = plan ? structurePlanIssues(plan, paletteColorIds) : [];
  const planValid = !!plan && !planIssues.length;
  const fixedViewsMissing = viewMode === 'fixed' && images.some((r) => !isStandardReferenceView(r.view));
  const viewOptions = (fixed: boolean) =>
    [...(!fixed ? ['auto' as const] : []), ...standardReferenceViews, ...(!fixed ? ['exclude' as const] : [])].map(
      (value) => ({ value, label: t(`imageModel.views.${value}`) }),
    );
  return (
    <>
      <Modal
        open={state.imageInputOpen}
        title={t('imageUi.inputTitle')}
        width={640}
        className="image-input-modal workflow-modal"
        okText={t('imageUi.makePlan')}
        cancelText={t('aiUi.cancel')}
        onCancel={() => useAiStore.setState({ imageInputOpen: false })}
        okButtonProps={{
          disabled:
            !provider ||
            !model ||
            fixedViewsMissing ||
            (!description.trim() && !images.length) ||
            (palette === 'custom' && !colorIds.length) ||
            (parts === 'categories' && !categories.length) ||
            (size === 'custom' && !Object.keys(dimensions).length),
        }}
        onOk={() => {
          if (provider)
            void startImageTask({
              providerId: provider.id,
              model,
              input: {
                description,
                viewMode,
                priority,
                images,
                style,
                targetSize: size === 'custom' ? dimensions : (size as 'small' | 'medium' | 'large'),
                palette: { source: palette, ...(palette === 'custom' ? { colorIds } : {}) },
                parts: { source: parts, ...(parts === 'categories' ? { categories } : {}) },
              },
              budget: { rounds, toolCalls: calls, durationMs: minutes * 60000 },
              directStart: direct,
            });
        }}
      >
        <div
          className="image-input-form"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void attach(e.dataTransfer.files);
          }}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              void attach(e.clipboardData.files);
            }
          }}
        >
          {error && <Alert type="error" title={t(error)} />}
          {!provider && (
            <Alert
              type="info"
              title={t('aiUi.chooseProvider')}
              action={
                <Button
                  onClick={() => {
                    usePreferences.setState({ page: 'ai' });
                    useAiStore.setState({ settingsOpen: true });
                  }}
                >
                  {t('aiUi.settings')}
                </Button>
              }
            />
          )}
          {provider && (
            <p className="secondary image-provider-note">
              {provider.name} · {model}
            </p>
          )}
          <div className="image-view-mode">
            <Radio.Group
              aria-label={t('imageUi.viewMode')}
              optionType="button"
              buttonStyle="solid"
              value={viewMode}
              onChange={(e) => setViewMode(e.target.value as 'auto' | 'fixed')}
              options={(['auto', 'fixed'] as const).map((value) => ({ value, label: t(`imageUi.viewModes.${value}`) }))}
            />
            <p className="secondary">{t(`imageUi.viewModeHint.${viewMode}`)}</p>
          </div>
          <div className="reference-drop-zone">
            <label className="reference-picker">
              <ImagePlus />
              <span>{t('imageUi.addImages')}</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                aria-label={t('imageUi.addImages')}
                onChange={(e) => {
                  if (e.target.files) void attach(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
            <small>{t('imageUi.imageHint')}</small>
            {!!images.length && (
              <Image.PreviewGroup>
                <div className="reference-grid">
                  {images.map((ref, index) => (
                    <div className="reference-cell" key={index}>
                      <Image src={imageSource(ref.image)} alt={ref.name} />
                      <select
                        className="reference-view-select"
                        aria-label={t('imageUi.viewNumber', { n: index + 1 })}
                        aria-invalid={viewMode === 'fixed' && !isStandardReferenceView(ref.view)}
                        value={viewMode === 'fixed' && !isStandardReferenceView(ref.view) ? '' : ref.view}
                        onChange={(e) =>
                          setImages(
                            images.map((r, i) => (i === index ? { ...r, view: e.target.value as ReferenceView } : r)),
                          )
                        }
                      >
                        <option value="" disabled>
                          {t('imageUi.chooseView')}
                        </option>
                        {viewOptions(viewMode === 'fixed').map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <Tooltip title={t('aiUi.removeImage')}>
                        <Button
                          className="reference-remove"
                          size="small"
                          icon={<X />}
                          aria-label={t('aiUi.removeImage')}
                          onClick={() => setImages(images.filter((_, i) => i !== index))}
                        />
                      </Tooltip>
                    </div>
                  ))}
                </div>
              </Image.PreviewGroup>
            )}
          </div>
          {fixedViewsMissing && <Alert type="warning" title={t('imageUi.fixedViewsRequired')} />}
          <label className="ai-form-field">
            <span>{t('imageUi.description')}</span>
            <Input.TextArea
              aria-label={t('imageUi.description')}
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('imageUi.descriptionHint')}
            />
          </label>
          <div className="workflow-form-grid">
            <label className="ai-form-field">
              <span>{t('imageUi.targetSize')}</span>
              <Select
                value={size}
                aria-label={t('imageUi.targetSize')}
                onChange={setSize}
                options={['small', 'medium', 'large', 'custom'].map((value) => ({
                  value,
                  label: t(`imageUi.sizes.${value}`),
                }))}
              />
            </label>
            <label className="ai-form-field">
              <span>{t('imageUi.style')}</span>
              <Input value={style} aria-label={t('imageUi.style')} onChange={(e) => setStyle(e.target.value)} />
            </label>
            {size === 'custom' && (
              <div className="image-dimensions full-row">
                {(['width', 'depth', 'height'] as const).map((axis) => (
                  <label key={axis}>
                    {t(`imageUi.${axis}`)}
                    <InputNumber
                      min={0.5}
                      max={512}
                      step={0.5}
                      value={dimensions[axis] ?? null}
                      aria-label={t(`imageUi.${axis}`)}
                      onChange={(value) => {
                        const next = { ...dimensions };
                        if (value) next[axis] = value;
                        else delete next[axis];
                        setDimensions(next);
                      }}
                    />
                  </label>
                ))}
              </div>
            )}
            <label className="ai-form-field">
              <span>{t('imageUi.palette')}</span>
              <Select
                value={palette}
                aria-label={t('imageUi.palette')}
                onChange={setPalette}
                options={['factory', 'project', 'custom'].map((value) => ({
                  value,
                  label: t(`imageUi.palettes.${value}`),
                }))}
              />
            </label>
            <label className="ai-form-field">
              <span>{t('imageUi.parts')}</span>
              <Select
                value={parts}
                aria-label={t('imageUi.parts')}
                onChange={setParts}
                options={['factory', 'categories', 'all'].map((value) => ({
                  value,
                  label: t(`imageUi.partSources.${value}`),
                }))}
              />
            </label>
            {palette === 'custom' && (
              <Select
                className="full-row"
                mode="multiple"
                aria-label={t('imageUi.colors')}
                value={colorIds}
                onChange={setColorIds}
                options={colors}
              />
            )}
            {parts === 'categories' && (
              <Select
                className="full-row"
                mode="multiple"
                aria-label={t('imageUi.categories')}
                value={categories}
                onChange={setCategories}
                options={library.categories.map((c) => ({
                  value: c.id,
                  label: language === 'en' ? c.nameEn : c.nameZh,
                }))}
              />
            )}

            <label className="ai-form-field">
              <span>{t('imageUi.priority')}</span>
              <Select
                value={priority}
                aria-label={t('imageUi.priority')}
                onChange={setPriority}
                options={['buildable', 'appearance'].map((value) => ({
                  value,
                  label: t(`imageUi.priorities.${value}`),
                }))}
              />
            </label>
          </div>
          <Checkbox checked={direct} onChange={(e) => setDirect(e.target.checked)}>
            {t('imageUi.direct')}
          </Checkbox>
          <p className="secondary">{t('imageUi.autoFinish')}</p>
          <details className="ai-page-advanced">
            <summary>{t('aiUi.advanced')}</summary>
            <div className="workflow-form-grid">
              <label className="ai-form-field">
                <span>{t('imageUi.roundLimit')}</span>
                <InputNumber
                  min={2}
                  max={20}
                  value={rounds}
                  aria-label={t('imageUi.roundLimit')}
                  onChange={(v) => setRounds(v ?? 20)}
                />
              </label>
              <label className="ai-form-field">
                <span>{t('imageUi.toolLimit')}</span>
                <InputNumber
                  min={1}
                  max={10000}
                  value={calls}
                  aria-label={t('imageUi.toolLimit')}
                  onChange={(v) => setCalls(v ?? 2000)}
                />
              </label>
              <label className="ai-form-field">
                <span>{t('imageUi.duration')}</span>
                <InputNumber
                  min={1}
                  max={120}
                  value={minutes}
                  aria-label={t('imageUi.duration')}
                  onChange={(v) => setMinutes(v ?? 120)}
                />
              </label>
            </div>
          </details>
        </div>
      </Modal>
      <Modal
        open={!!plan && !!state.workflow?.state?.awaitingConfirmation && !state.workflow.state.paused && state.running}
        title={t('imageUi.planTitle')}
        width={960}
        className="image-plan-modal workflow-modal"
        okText={t('imageUi.start')}
        cancelText={t('aiUi.cancel')}
        okButtonProps={{ disabled: !planValid }}
        footer={(_, { OkBtn, CancelBtn }) => (
          <div className="plan-footer">
            {!!planIssues.length && (
              <div className="plan-errors" role="alert">
                {planIssues.map((issue, index) => {
                  const rowIndex = plan?.buildOrder.indexOf(issue.componentId ?? '') ?? -1;
                  return (
                    <button
                      key={index}
                      type="button"
                      className="plan-error-link"
                      onClick={() => {
                        const target =
                          (issue.componentId ? planRows.current.get(issue.componentId) : null) ?? planForm.current;
                        target?.scrollIntoView({ block: 'center' });
                        target?.focus({ preventScroll: true });
                      }}
                    >
                      {t(issue.componentId ? 'imageUi.planComponentError' : 'imageUi.planError', {
                        n:
                          rowIndex >= 0
                            ? rowIndex + 1
                            : (plan?.components.findIndex((c) => c.id === issue.componentId) ?? 0) + 1,
                        reason: t(`imageUi.planErrors.${issue.field}`),
                      })}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="plan-footer-actions">
              <CancelBtn />
              <OkBtn />
            </div>
          </div>
        )}
        onCancel={() => void window.brickloop.aiStop(state.workflow?.taskId)}
        onOk={() => {
          if (plan)
            void window.brickloop.aiConfirmPlan(plan, state.workflow?.taskId).then((ok) => {
              if (!ok) setError('imageUi.invalidPlan');
            });
        }}
      >
        {plan && (
          <div className="image-plan-form" ref={planForm} tabIndex={-1}>
            {!!state.workflow?.request.input.images.length && (
              <section className="plan-reference-section" aria-label={t('imageUi.referenceViews')}>
                <strong>{t('imageUi.referenceViews')}</strong>
                <p className="secondary">
                  {t(
                    state.workflow.request.input.viewMode === 'fixed'
                      ? 'imageUi.fixedReferenceViewsHint'
                      : 'imageUi.referenceViewsHint',
                  )}
                </p>
                {!!state.workflow.viewWarnings?.length && (
                  <Alert type="warning" title={t('imageUi.viewEstimateWarning')} />
                )}
                <Image.PreviewGroup>
                  <div className="plan-reference-grid">
                    {state.workflow.request.input.images.map((ref, index) => {
                      const referenceId = planningReferenceId(index);
                      const estimate = plan.viewEstimates?.find((v) => v.referenceId === referenceId);
                      const selected =
                        plan.viewOverrides?.find((v) => v.referenceId === referenceId)?.view ??
                        (ref.view === 'unknown' ? 'auto' : ref.view);
                      return (
                        <div className="plan-reference-cell" key={referenceId}>
                          <Image src={imageSource(ref.image)} alt={ref.name} />
                          <span className="plan-reference-name" title={ref.name}>
                            {ref.name}
                          </span>
                          <span className="plan-view-estimate" title={estimate?.reason || undefined}>
                            {estimate
                              ? t('imageUi.viewEstimate', {
                                  view: t(`imageModel.views.${estimate.view}`),
                                  confidence: estimate.confidence.toFixed(2),
                                })
                              : t(`imageModel.viewSource.${ref.view === 'exclude' ? 'excluded' : 'designer'}`)}
                          </span>
                          <select
                            className="reference-view-select"
                            aria-label={t('imageUi.planViewNumber', { n: index + 1 })}
                            value={selected}
                            onChange={(e) =>
                              setPlan({
                                ...plan,
                                viewOverrides: [
                                  ...(plan.viewOverrides ?? []).filter((v) => v.referenceId !== referenceId),
                                  {
                                    referenceId,
                                    view: e.target.value as NonNullable<StructurePlan['viewOverrides']>[number]['view'],
                                  },
                                ],
                              })
                            }
                          >
                            {viewOptions(state.workflow?.request.input.viewMode === 'fixed')
                              .filter((option) => option.value !== 'auto' || !!estimate)
                              .map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                </Image.PreviewGroup>
              </section>
            )}
            <Input
              aria-label={t('imageUi.planName')}
              value={plan.name}
              onChange={(e) => setPlan({ ...plan, name: e.target.value })}
            />
            <p className="secondary">{t('imageUi.planHint')}</p>
            {!!(colorRepairs.length + boxRepairs.length) && (
              <details className="plan-color-repairs">
                <summary>
                  {t(
                    'imageUi.planRepairs.' +
                      (colorRepairs.length && boxRepairs.length ? 'both' : colorRepairs.length ? 'colors' : 'boxes'),
                    {
                      n: colorRepairs.length + boxRepairs.length,
                      colors: colorRepairs.length,
                      boxes: boxRepairs.length,
                    },
                  )}
                </summary>
                {!!colorRepairs.length && <p>{t('imageUi.colorRepairs', { n: colorRepairs.length })}</p>}
                <ul>
                  {colorRepairs.map((repair, index) => (
                    <li key={index}>
                      {t(`imageUi.colorRepairDetails.${repair.reason ?? (repair.to ? 'replaced' : 'removed')}`, {
                        component: plan.components.find((c) => c.id === repair.componentId)?.name ?? repair.componentId,
                        from: repair.from,
                        to: repair.to ? colorName(repair.to) : '',
                      })}
                    </li>
                  ))}
                  {boxRepairs.map((repair, index) => (
                    <li key={`box-${index}`}>
                      {t('imageUi.planRepairs.boxDetail', {
                        n: plan.buildOrder.indexOf(repair.componentId) + 1,
                        component: plan.components.find((c) => c.id === repair.componentId)?.name ?? repair.componentId,
                        from: formatBoxCorner(repair.from.max),
                        to: formatBoxCorner(repair.to.max),
                      })}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <table className="image-plan-table">
              <thead>
                <tr>
                  {['order', 'component', 'boundingBox', 'colors', 'partTypes', 'connections'].map((key) => (
                    <th key={key}>{t(`imageUi.${key}`)}</th>
                  ))}
                  <th>
                    <span className="sr-only">{t('imageUi.deleteRow')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {plan.buildOrder.map((id, index) => {
                  const row = plan.components.find((c) => c.id === id)!;
                  return (
                    <tr
                      key={id}
                      ref={(element) => {
                        if (element) planRows.current.set(id, element);
                        else planRows.current.delete(id);
                      }}
                      tabIndex={-1}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (dragged) reorder(dragged, index);
                        setDragged(null);
                      }}
                    >
                      <td>
                        <div className="plan-order">
                          <span draggable onDragStart={() => setDragged(id)} title={t('imageUi.dragOrder')}>
                            <GripVertical />
                            {index + 1}
                          </span>
                          <div>
                            <Button
                              size="small"
                              type="text"
                              icon={<ArrowUp />}
                              aria-label={t('imageUi.moveUp')}
                              disabled={index === 0}
                              onClick={() => reorder(id, index - 1)}
                            />
                            <Button
                              size="small"
                              type="text"
                              icon={<ArrowDown />}
                              aria-label={t('imageUi.moveDown')}
                              disabled={index === plan.buildOrder.length - 1}
                              onClick={() => reorder(id, index + 1)}
                            />
                          </div>
                        </div>
                      </td>
                      <td>
                        <Input
                          aria-label={t('imageUi.component')}
                          value={row.name}
                          onChange={(e) => editRow(id, { name: e.target.value })}
                        />
                        <select
                          className="reference-view-select"
                          aria-label={t('imageUi.designCategory')}
                          value={row.category ?? 'buildings'}
                          onChange={(e) =>
                            editRow(id, { category: e.target.value as NonNullable<typeof row.category> })
                          }
                        >
                          {designCategories.map((category) => (
                            <option key={category} value={category}>
                              {t(`imageUi.designCategories.${category}`)}
                            </option>
                          ))}
                        </select>
                        <select
                          className="reference-view-select"
                          aria-label={t('imageUi.strategy')}
                          value={row.strategy ?? 'shapes'}
                          onChange={(e) => editRow(id, { strategy: e.target.value as 'shapes' | 'parts' })}
                        >
                          {['shapes', 'parts'].map((strategy) => (
                            <option key={strategy} value={strategy}>
                              {t(`imageUi.strategies.${strategy}`)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <small>{t('imageUi.origin')}</small>
                        <div className="plan-dimensions">
                          {(['x', 'y', 'z'] as const).map((axis) => (
                            <input
                              key={axis}
                              type="number"
                              step={0.5}
                              aria-label={t(`imageUi.originAxis.${axis}`)}
                              value={row.boundingBox?.min[axis] ?? 0}
                              onChange={(e) => {
                                const b = row.boundingBox ?? {
                                  min: { x: 0, y: 0, z: 0 },
                                  max: { x: row.size.width, y: row.size.height, z: row.size.depth },
                                };
                                const value = Number(e.target.value);
                                editRow(id, {
                                  boundingBox: {
                                    min: { ...b.min, [axis]: value },
                                    max: { ...b.max, [axis]: b.max[axis] + value - b.min[axis] },
                                  },
                                });
                              }}
                            />
                          ))}
                        </div>
                        <small>{t('imageUi.dimensions')}</small>
                        <div className="plan-dimensions">
                          {(['width', 'depth', 'height'] as const).map((axis) => (
                            <input
                              key={axis}
                              type="number"
                              min={0.5}
                              step={0.5}
                              aria-label={t(`imageUi.${axis}`)}
                              value={row.size[axis] || ''}
                              onChange={(e) => {
                                const size = { ...row.size, [axis]: Number(e.target.value) };
                                const min = row.boundingBox?.min ?? { x: 0, y: 0, z: 0 };
                                editRow(id, {
                                  size,
                                  boundingBox: {
                                    min,
                                    max: { x: min.x + size.width, y: min.y + size.height, z: min.z + size.depth },
                                  },
                                });
                              }}
                            />
                          ))}
                        </div>
                      </td>
                      <td>
                        <Select
                          mode="multiple"
                          tagRender={({ label }) => <span className="plan-color-tag">{label}</span>}
                          aria-label={t('imageUi.colors')}
                          value={row.colors}
                          options={planColors}
                          onChange={(value) => editRow(id, { colors: value })}
                        />
                      </td>
                      <td>
                        <Input.TextArea
                          autoSize={{ minRows: 1, maxRows: 3 }}
                          aria-label={t('imageUi.partTypes')}
                          value={row.partTypes.join('、')}
                          onChange={(e) => editRow(id, { partTypes: e.target.value.split(/[、,]/).filter(Boolean) })}
                        />
                      </td>
                      <td>
                        <Select
                          mode="multiple"
                          aria-label={t('imageUi.connections')}
                          tagRender={({ label }) => <span className="plan-color-tag">{label}</span>}
                          value={row.connections.map((c) => c.target)}
                          options={plan.components
                            .filter((c) => c.id !== id)
                            .map((c) => ({ value: c.id, label: c.name }))}
                          onChange={(targets: string[]) =>
                            editRow(id, {
                              connections: targets.map(
                                (target) =>
                                  row.connections.find((c) => c.target === target) ?? {
                                    target,
                                    description: t('imageUi.connectHint'),
                                  },
                              ),
                            })
                          }
                        />
                      </td>
                      <td>
                        <Button
                          type="text"
                          size="small"
                          icon={<Trash2 />}
                          aria-label={t('imageUi.deleteRow')}
                          onClick={() =>
                            setPlan({
                              ...plan,
                              components: plan.components
                                .filter((c) => c.id !== id)
                                .map((c) => ({ ...c, connections: c.connections.filter((v) => v.target !== id) })),
                              buildOrder: plan.buildOrder.filter((v) => v !== id),
                            })
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Button
              icon={<Plus />}
              onClick={() => {
                const id = crypto.randomUUID();
                setPlan({
                  ...plan,
                  components: [
                    ...plan.components,
                    {
                      id,
                      name: t('imageUi.newComponent'),
                      size: { width: 4, depth: 4, height: 3 },
                      colors: paletteColorIds[0] ? [paletteColorIds[0]] : [],
                      partTypes: [t('imageUi.bricks')],
                      connections: [],
                      category: 'buildings',
                      strategy: 'shapes',
                      boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 3, z: 4 } },
                    },
                  ],
                  buildOrder: [...plan.buildOrder, id],
                });
              }}
            >
              {t('imageUi.addRow')}
            </Button>
          </div>
        )}
      </Modal>
    </>
  );
}
