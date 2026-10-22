import { usePreferences, shortcutText } from './preferences-store';
import { useEffect, useState } from 'react';
import { Alert, Button, Dropdown, Tooltip } from 'antd';
import { Box, ChevronLeft, ChevronRight, GripVertical, MoreHorizontal, Plus, X } from 'lucide-react';
import { expandInstances, resolveContext } from '@brickloop/core';
import type { BrkDocument, ModelDef } from '@brickloop/core';
import {
  addStep,
  advanceStep,
  chooseStep,
  currentStepId,
  dispatchEdit,
  documentSession,
  removeStep,
  toggleStepViewing,
  useDocumentStore,
} from './document-store';
import { renderModelThumbnail } from './model-thumbnail';
import { useLibraryStore } from './library-store';
import { useTranslation } from './store';

const images = new Map<string, string>();
function StepThumbnail({ doc, model, id }: { doc: BrkDocument; model: ModelDef; id: string }) {
  const t = useTranslation(),
    [image, setImage] = useState(''),
    [failed, setFailed] = useState(false);
  const { revision, allColors, status } = useLibraryStore();
  const source: BrkDocument = {
    ...doc,
    rootModelId: model.id,
    models: {
      ...doc.models,
      [model.id]: {
        ...model,
        stepIds: [id],
        steps: { [id]: model.steps[id]! },
        instances: Object.fromEntries(model.steps[id]!.instanceIds.map((id) => [id, model.instances[id]!])),
      },
    },
  };
  const rows = expandInstances(source);
  const key = JSON.stringify([
    status?.pack?.id,
    revision,
    rows.map((row) => [row.partId, row.colorId, Array.from(row.worldMatrix)]),
  ]);
  useEffect(() => {
    if (!rows.length || !allColors.length) return;
    let active = true;
    setImage(images.get(key) ?? '');
    setFailed(false);
    if (!images.has(key))
      void renderModelThumbnail(source, false, () => active)
        .then((png) => {
          if (!png) return;
          images.set(key, png);
          if (images.size > 128) images.delete(images.keys().next().value!);
          if (active) setImage(png);
        })
        .catch(() => {
          if (active) setFailed(true);
        });
    return () => {
      active = false;
    };
  }, [key, allColors]);
  return (
    <span className="step-thumbnail">
      {!rows.length ? (
        <Box aria-label={t('stepsUi.empty')} />
      ) : image ? (
        <img src={image} alt="" width={64} height={64} />
      ) : failed ? (
        <Box aria-label={t('libraryUi.geometryMissing')} />
      ) : (
        <span className="thumbnail-skeleton" />
      )}
    </span>
  );
}

export function StepsPanel() {
  const t = useTranslation(),
    { document: doc, workspace, stepNotice, stepViewing, locked } = useDocumentStore();
  const model = resolveContext(doc, documentSession.context)!.model,
    current = currentStepId();
  const [over, setOver] = useState<string | null>(null);
  const counts = new Map<string, number>();
  for (const row of expandInstances(doc)) {
    if (!workspace.activeModelPath.every((id, index) => row.path[index] === id)) continue;
    const instance = model.instances[row.path[workspace.activeModelPath.length]!];
    if (instance) counts.set(instance.stepId, (counts.get(instance.stepId) ?? 0) + 1);
  }
  return (
    <div className="steps-panel">
      <div className="panel-heading">
        <h2>{t('stepsUi.title')}</h2>
        <Tooltip title={t('desktop.commands.step.add.label')}>
          <Button
            type="text"
            size="small"
            icon={<Plus />}
            aria-label={t('desktop.commands.step.add.label')}
            disabled={stepViewing || !!locked}
            onClick={addStep}
          />
        </Tooltip>
      </div>
      {stepNotice && (
        <Alert
          className="step-notice"
          type="info"
          title={stepNotice}
          closable
          onClose={() => useDocumentStore.setState({ stepNotice: null })}
        />
      )}
      <div className="step-list" role="list" aria-label={t('stepsUi.title')}>
        {model.stepIds.map((id, index) => (
          <div
            key={id}
            role="listitem"
            data-step-id={id}
            className={`step-row ${id === current ? 'selected' : ''} ${over === id ? 'drop-target' : ''}`}
            draggable={!stepViewing && !locked}
            onDragStart={(event) => {
              event.dataTransfer.setData('application/x-brickloop-step', id);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes('application/x-brickloop-step')) {
                event.preventDefault();
                setOver(id);
              }
            }}
            onDragLeave={() => setOver(null)}
            onDragEnd={() => setOver(null)}
            onDrop={(event) => {
              event.preventDefault();
              setOver(null);
              const moving = event.dataTransfer.getData('application/x-brickloop-step');
              if (model.steps[moving]) dispatchEdit({ type: 'step.move', stepId: moving, position: index });
            }}
          >
            <GripVertical className="step-grip" aria-label={t('stepsUi.drag')} />
            <button className="step-select" aria-pressed={id === current} onClick={() => chooseStep(id)}>
              <StepThumbnail doc={doc} model={model} id={id} />
              <span className="step-caption">
                <strong>{t('editor.step', { number: index + 1 })}</strong>
                <span>{t('macroUi.parts', { count: counts.get(id) ?? 0 })}</span>
              </span>
            </button>
            <Dropdown
              destroyOnHidden
              trigger={['click']}
              menu={{
                items: [
                  {
                    key: 'assign',
                    label: t('stepsUi.assign'),
                    disabled: !workspace.selection.length || stepViewing || !!locked,
                    onClick: () => {
                      if (dispatchEdit({ type: 'step.assign', stepId: id })) chooseStep(id);
                    },
                  },
                  {
                    key: 'up',
                    label: t('structure.stepUp'),
                    disabled: index === 0 || stepViewing || !!locked,
                    onClick: () => dispatchEdit({ type: 'step.move', stepId: id, position: index - 1 }),
                  },
                  {
                    key: 'down',
                    label: t('structure.stepDown'),
                    disabled: index === model.stepIds.length - 1 || stepViewing || !!locked,
                    onClick: () => dispatchEdit({ type: 'step.move', stepId: id, position: index + 1 }),
                  },
                  {
                    key: 'remove',
                    label: t('desktop.commands.step.remove.label'),
                    disabled: model.stepIds.length === 1 || stepViewing || !!locked,
                    onClick: () => removeStep(id),
                  },
                ],
              }}
            >
              <Button type="text" icon={<MoreHorizontal />} aria-label={t('stepsUi.actions', { number: index + 1 })} />
            </Dropdown>
          </div>
        ))}
      </div>
    </div>
  );
}

export function StepNavigation() {
  usePreferences((s) => s.value.shortcuts);
  const t = useTranslation(),
    { document: doc, stepViewing } = useDocumentStore();
  if (!stepViewing) return null;
  const model = resolveContext(doc, documentSession.context)!.model,
    index = model.stepIds.indexOf(currentStepId());
  return (
    <div className="step-navigation" role="region" aria-label={t('stepsUi.navigation')}>
      <Tooltip title={`${t('stepsUi.previous')} ${shortcutText('rotate.left')}`}>
        <Button
          type="text"
          icon={<ChevronLeft />}
          aria-label={t('stepsUi.previous')}
          disabled={index <= 0}
          onClick={() => advanceStep(-1)}
        />
      </Tooltip>
      <Tooltip title={`${t('stepsUi.next')} ${shortcutText('rotate.right')}`}>
        <Button
          type="text"
          icon={<ChevronRight />}
          aria-label={t('stepsUi.next')}
          disabled={index === model.stepIds.length - 1}
          onClick={() => advanceStep(1)}
        />
      </Tooltip>
      <input
        type="range"
        aria-label={t('stepsUi.progress')}
        min={1}
        max={model.stepIds.length}
        value={index + 1}
        onChange={(event) => chooseStep(model.stepIds[Number(event.target.value) - 1]!)}
      />
      <span aria-live="polite">{t('stepsUi.position', { number: index + 1, total: model.stepIds.length })}</span>
      <Tooltip title={`${t('stepsUi.exit')} ${shortcutText('editor.escape')}`}>
        <Button type="text" icon={<X />} aria-label={t('stepsUi.exit')} onClick={() => toggleStepViewing(false)} />
      </Tooltip>
    </div>
  );
}
