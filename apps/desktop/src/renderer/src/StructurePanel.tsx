import { hasAnimationParts, openBuildAnimation } from './animation-host';
import { shortcutText, usePreferences } from './preferences-store';
import { useState } from 'react';
import { Button, Dropdown, Tooltip, Segmented } from 'antd';
import { ChevronDown, ChevronRight, Eye, EyeOff, Folder, ListTree, Plus, TableProperties } from 'lucide-react';
import {
  groupAncestors,
  orderedInstances,
  pathStartsWith,
  resolveContext,
  resolvePath,
  expandInstances,
} from '@brickloop/core';
import type { BrkDocument, Instance, InstancePath, ModelDef } from '@brickloop/core';
import {
  dispatchEdit,
  chooseStep,
  removeStep,
  documentSession,
  enterContext,
  refresh,
  runEditorAction,
  selectPaths,
  useDocumentStore,
} from './document-store';
import { placeSubmodel, selectTree, useProjectUi } from './project-controller';
import { useTranslation, useShellStore } from './store';
import { StepsPanel } from './StepsPanel';
import { partNames, useAssemblyStore } from './assembly-store';
import { useLibraryStore } from './library-store';
import { scriptForModel } from '../../shared/buildscript-document';
import { openBuildScript, convertBuildScript } from './BuildScriptDialog';
import { selectedModel } from './project-controller';

export function modelReferences(doc: BrkDocument) {
  const counts = new Map<string, number>();
  function visit(id: string, stack: Set<string>) {
    if (stack.has(id)) return;
    const next = new Set([...stack, id]);
    for (const row of Object.values(doc.models[id]?.instances ?? {}))
      if (row.ref.kind === 'model') {
        counts.set(row.ref.modelId, (counts.get(row.ref.modelId) ?? 0) + 1);
        visit(row.ref.modelId, next);
      }
  }
  visit(doc.rootModelId, new Set());
  return counts;
}
export function StructurePanel() {
  const t = useTranslation(),
    view = useShellStore((state) => state.structureView);
  return (
    <div className="structure-panel">
      <div className="structure-view-tabs">
        <Segmented
          block
          value={view}
          aria-label={t('stepsUi.view')}
          onChange={(value) => useShellStore.setState({ structureView: value as 'tree' | 'steps' })}
          options={[
            { value: 'tree', label: t('structure.modelTree') },
            { value: 'steps', label: t('structure.steps') },
          ]}
        />
      </div>
      {view === 'steps' ? <StepsPanel /> : <ModelTreePanel />}
    </div>
  );
}
function ModelTreePanel() {
  useAssemblyStore((state) => state.ready);
  const colors = useLibraryStore((state) => state.allColors);
  const t = useTranslation(),
    { document: doc, workspace } = useDocumentStore();
  const focusedModel = useProjectUi((state) => state.focusedModel);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const references = modelReferences(doc);
  const worldColors = new Map(expandInstances(doc).map((row) => [row.path.join('/'), row.colorId]));
  const isOpen = (key: string) => !collapsed.has(key);
  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const matches = (path: InstancePath) => workspace.selection.some((p) => p.join('/') === path.join('/'));
  function row(options: {
    key: string;
    label: string;
    color?: string | undefined;
    number?: string;
    depth: number;
    paths: InstancePath[];
    modelPath: InstancePath;
    groupId: string | null;
    folder?: boolean;
    expandable?: boolean;
    count?: number;
    script?: boolean;
    enter?: () => void;
    choose?: () => void;
    menu?: React.ReactNode;
  }) {
    const { key, label, paths, depth } = options;
    const hidden = paths.length > 0 && paths.every((path) => workspace.hidden.some((p) => pathStartsWith(path, p)));
    const selected = paths.length > 0 && paths.every(matches);
    return (
      <div
        key={key}
        role="treeitem"
        aria-selected={selected}
        aria-expanded={options.expandable ? isOpen(key) : undefined}
        className={`structure-row ${selected ? 'selected' : ''} ${hidden ? 'hidden-row' : ''}`}
        style={{ paddingLeft: depth * 16 }}
        data-tree-key={key}
        onContextMenu={(event) => {
          event.preventDefault();
          if (!selected) selectTree(paths, options.modelPath, false);
          useDocumentStore.setState({ contextMenu: { x: event.clientX, y: event.clientY } });
        }}
      >
        <button
          className="tree-toggle"
          tabIndex={options.expandable ? 0 : -1}
          aria-label={t(isOpen(key) ? 'structure.collapse' : 'structure.expand')}
          onClick={() => toggle(key)}
        >
          {options.expandable ? isOpen(key) ? <ChevronDown /> : <ChevronRight /> : null}
        </button>
        <button
          className="tree-name"
          title={label}
          onClick={(event) => {
            if (event.altKey && options.enter) options.enter();
            else if (options.choose) options.choose();
            else selectTree(paths, options.modelPath, event.ctrlKey || event.shiftKey);
          }}
          onDoubleClick={() => options.enter?.()}
        >
          {options.folder && <Folder />}
          {options.color && <span className="tree-color-dot" style={{ backgroundColor: options.color }} />}
          <span>{label}</span>
          {options.script && <span className="build-script-badge">{t('buildScriptUi.badge')}</span>}
          {options.number && <span className="tree-part-number">{options.number}</span>}
          {options.count !== undefined && <span className="shared-count">×{options.count}</span>}
        </button>
        {options.menu}
        {!!paths.length && (
          <Tooltip title={t(hidden ? 'editor.showPart' : 'editor.hidePart')}>
            <Button
              type="text"
              size="small"
              className="tree-eye"
              icon={hidden ? <EyeOff /> : <Eye />}
              aria-label={t(hidden ? 'editor.showPart' : 'editor.hidePart')}
              onClick={() => {
                if (documentLocked()) return;
                documentSession.updateWorkspace({
                  hidden: hidden
                    ? workspace.hidden.filter((h) => !paths.some((p) => pathStartsWith(p, h) || pathStartsWith(h, p)))
                    : [...workspace.hidden, ...paths],
                  selection: hidden
                    ? workspace.selection
                    : workspace.selection.filter((p) => !paths.some((h) => pathStartsWith(p, h))),
                });
                refresh();
              }}
            />
          </Tooltip>
        )}
      </div>
    );
  }
  function modelTree(model: ModelDef, path: InstancePath, depth: number): React.ReactNode {
    return model.stepIds.map((id, index) => {
      const step = model.steps[id]!,
        key = `${path.join('/')}/step/${id}`;
      const members = step.instanceIds.map((id) => model.instances[id]!).filter(Boolean);
      const stepMenu = (
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              {
                key: 'assign',
                label: t('desktop.commands.step.assign.label'),
                disabled: !workspace.selection.length,
                onClick: () => dispatchEdit({ type: 'step.assign', stepId: id }),
              },
              {
                key: 'up',
                label: t('structure.stepUp'),
                disabled: index === 0,
                onClick: () => dispatchEdit({ type: 'step.move', stepId: id, position: index - 1 }),
              },
              {
                key: 'down',
                label: t('structure.stepDown'),
                disabled: index === model.stepIds.length - 1,
                onClick: () => dispatchEdit({ type: 'step.move', stepId: id, position: index + 1 }),
              },
              {
                key: 'remove',
                label: t('desktop.commands.step.remove.label'),
                disabled: model.stepIds.length === 1,
                onClick: () => removeStep(id),
              },
            ],
          }}
        >
          <button
            className="step-actions"
            aria-label={t('structure.stepActions')}
            onClick={() => {
              if (documentLocked()) return;
              if (documentSession.workspace.activeModelPath.join('/') !== path.join('/')) enterContext(path);
              chooseStep(id);
            }}
          >
            ···
          </button>
        </Dropdown>
      );
      return (
        <div key={key} role="group">
          {row({
            key,
            label: `${t('editor.step', { number: index + 1 })}${step.description ? ` · ${step.description}` : ''}`,
            depth,
            paths: [],
            modelPath: path,
            groupId: null,
            expandable: true,
            menu: stepMenu,
            choose: () => {
              if (documentLocked()) return;
              if (workspace.activeModelPath.join('/') !== path.join('/')) enterContext(path);
              chooseStep(id);
              toggle(key);
            },
          })}
          {isOpen(key) && grouped(members, null, path, depth + 1, id)}
        </div>
      );
    });
  }
  function grouped(
    members: Instance[],
    parent: string | null,
    path: InstancePath,
    depth: number,
    step: string,
  ): React.ReactNode {
    const emitted = new Set<string>();
    return members.flatMap((instance) => {
      const chain = groupAncestors(doc, instance.groupId).reverse();
      const position = parent ? chain.findIndex((g) => g.id === parent) + 1 : 0;
      const group = chain[position];
      if (group) {
        if (emitted.has(group.id)) return [];
        emitted.add(group.id);
        const groupedMembers = members.filter((i) => groupAncestors(doc, i.groupId).some((g) => g.id === group.id));
        // A group may span steps; selecting its row always selects the whole group.
        const model = resolveContext(doc, { activeModelPath: path })!.model;
        const allMembers = orderedInstances(model).filter((i) =>
          groupAncestors(doc, i.groupId).some((g) => g.id === group.id),
        );
        const key = `${path.join('/')}/group/${group.id}/${step}`;
        return [
          <div key={key} role="group">
            {row({
              key,
              label: group.name,
              depth,
              paths: allMembers.map((i) => [...path, i.id]),
              modelPath: path,
              groupId: parent,
              folder: true,
              expandable: true,
              enter: () => enterContext(path, group.id),
            })}
            {isOpen(key) && grouped(groupedMembers, group.id, path, depth + 1, step)}
          </div>,
        ];
      }
      const childPath = [...path, instance.id],
        key = childPath.join('/'),
        model = instance.ref.kind === 'model' ? doc.models[instance.ref.modelId] : undefined;
      return [
        <div key={key} role="group">
          {row({
            key,
            label:
              model?.name ??
              (instance.ref.kind === 'part'
                ? (partNames.get(instance.ref.partId)?.nameZh ?? t('connectUi.unnamedPart'))
                : ''),
            ...(instance.ref.kind === 'part'
              ? {
                  number: instance.ref.partId.replace(/^(ld|cu):/, ''),
                  color:
                    colors.find((color) => color.id === worldColors.get(childPath.join('/')))?.rgb ??
                    colors.find((color) => color.ldrawCode === 71)?.rgb,
                }
              : {}),
            depth,
            paths: [childPath],
            modelPath: path,
            groupId: parent,
            expandable: !!model,
            ...(model
              ? {
                  count: references.get(model.id) ?? 0,
                  script: scriptForModel(doc, model.id).length > 0,
                  enter: () => enterContext(childPath),
                }
              : {}),
          })}
          {model && isOpen(key) && modelTree(model, childPath, depth + 1)}
        </div>,
      ];
    });
  }
  const submodels = Object.values(doc.models).filter((m) => m.kind === 'submodel');
  return (
    <div className="structure-panel">
      <div className="panel-heading">
        <h2>{t('structure.modelTree')}</h2>
        <div className="panel-actions">
          <Tooltip title={t('desktop.commands.step.add.label')}>
            <Button
              type="text"
              size="small"
              icon={<Plus />}
              aria-label={t('desktop.commands.step.add.label')}
              onClick={() => runEditorAction('step.add')}
            />
          </Tooltip>
          <Tooltip title={t('output.bom')}>
            <Button
              type="text"
              size="small"
              icon={<TableProperties />}
              aria-label={t('output.bom')}
              onClick={() => useProjectUi.setState({ exportFormat: 'xlsx' })}
            />
          </Tooltip>
        </div>
      </div>
      <div className="structure-tree" role="tree" aria-label={t('structure.modelTree')}>
        {row({
          key: 'root',
          label: t('editor.mainModel'),
          depth: 0,
          paths: [],
          modelPath: [],
          groupId: null,
          expandable: true,
          choose: () => enterContext([]),
        })}
        {isOpen('root') && modelTree(doc.models[doc.rootModelId]!, [], 1)}
        {!Object.keys(doc.models[doc.rootModelId]!.instances).length && (
          <div className="empty-state">
            <ListTree />
            <p>{t('desktop.inspector.structure.empty')}</p>
          </div>
        )}
      </div>
      <div className="submodel-list">
        <div className="panel-heading">
          <h2>{t('structure.definitions')}</h2>
          <span className="secondary">{submodels.length}</span>
        </div>
        {[false, true].map((unused) => (
          <div key={String(unused)}>
            {unused && submodels.some((m) => !references.has(m.id)) && (
              <div className="submodel-section">{t('structure.unused')}</div>
            )}
            {submodels
              .filter((m) => !references.has(m.id) === unused)
              .map((model) => (
                <div
                  key={model.id}
                  className={`structure-row definition-row ${focusedModel === model.id ? 'selected' : ''}`}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    selectPaths([]);
                    useProjectUi.setState({ focusedModel: model.id });
                    useDocumentStore.setState({ contextMenu: { x: event.clientX, y: event.clientY } });
                  }}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData('application/x-brickloop-model', model.id);
                    event.dataTransfer.effectAllowed = 'copy';
                  }}
                >
                  <button
                    className="tree-name"
                    onClick={() => {
                      selectPaths([]);
                      useProjectUi.setState({ focusedModel: model.id });
                    }}
                    onDoubleClick={() => void placeSubmodel(model.id)}
                  >
                    {model.name}
                    {!!scriptForModel(doc, model.id).length && (
                      <span className="build-script-badge">{t('buildScriptUi.badge')}</span>
                    )}
                    <span className="shared-count">×{references.get(model.id) ?? 0}</span>
                  </button>
                  <Tooltip title={t('desktop.commands.submodel.instantiate.label')}>
                    <Button
                      type="text"
                      size="small"
                      icon={<Plus />}
                      aria-label={t('desktop.commands.submodel.instantiate.label')}
                      onClick={() => void placeSubmodel(model.id)}
                    />
                  </Tooltip>
                </div>
              ))}
          </div>
        ))}
        {!submodels.length && <p className="secondary submodel-help">{t('structure.noDefinitions')}</p>}
      </div>
    </div>
  );
}

export function EditorContextMenu() {
  usePreferences((s) => s.value.shortcuts);
  const { contextMenu, workspace, document: doc } = useDocumentStore(),
    t = useTranslation();
  if (!contextMenu) return null;
  const hasModel = workspace.selection.some((path) => resolvePath(doc, path)?.instance.ref.kind === 'model');
  const model = selectedModel(),
    scripts = scriptForModel(doc, model?.id ?? doc.rootModelId);
  return (
    <>
      <div className="context-dismiss" onPointerDown={() => useDocumentStore.setState({ contextMenu: null })} />
      <div
        className="viewport-context-menu"
        role="menu"
        style={{
          position: 'fixed',
          left: Math.min(contextMenu.x, innerWidth - 252),
          top: Math.max(8, Math.min(contextMenu.y, innerHeight - 520)),
          maxHeight: 'min(512px, calc(100vh - 16px))',
          overflowY: 'auto',
        }}
      >
        {model && (
          <button
            role="menuitem"
            disabled={!hasAnimationParts(doc, model.id)}
            title={hasAnimationParts(doc, model.id) ? undefined : t('animationUi.empty')}
            onClick={() => {
              useDocumentStore.setState({ contextMenu: null });
              openBuildAnimation(model.id);
            }}
          >
            {t('animationUi.playEntry')}
          </button>
        )}
        {scripts.flatMap(({ script }) => [
          <button role="menuitem" key={`${script.scriptId}:view`} onClick={() => openBuildScript(script.scriptId)}>
            {t('buildScriptUi.view')}
            {scripts.length > 1 ? ` · ${script.name}` : ''}
          </button>,
          <button
            role="menuitem"
            key={`${script.scriptId}:run`}
            disabled={documentLocked()}
            onClick={() => openBuildScript(script.scriptId, 'run')}
          >
            {t('buildScriptUi.rerun')}
          </button>,
          <button
            role="menuitem"
            key={`${script.scriptId}:detach`}
            disabled={documentLocked()}
            onClick={() => convertBuildScript(script.scriptId)}
          >
            {t('buildScriptUi.detach')}
          </button>,
        ])}
        {[
          'macro.saveSelection',
          'group.create',
          'group.dissolve',
          'submodel.create',
          'submodel.instantiate',
          'submodel.independent',
          'submodel.makeUnique',
          'submodel.explode',
          'structure.rename',
          'edit.copy',
          'edit.cut',
          'edit.paste',
          'edit.delete',
          'view.hide',
          'select.sameColor',
          'select.sameType',
          'view.fitSelection',
        ].map((action) => (
          <button
            key={action}
            role="menuitem"
            disabled={
              action.startsWith('submodel.') && action !== 'submodel.create'
                ? !hasModel
                : action !== 'edit.paste' && !workspace.selection.length
            }
            onClick={() => runEditorAction(action)}
          >
            {t(action === 'structure.rename' ? 'structure.rename' : `desktop.commands.${action}.label`)}
            <span className="shortcut">{shortcutText(action)}</span>
          </button>
        ))}
      </div>
    </>
  );
}
import { documentLocked } from './document-store';
