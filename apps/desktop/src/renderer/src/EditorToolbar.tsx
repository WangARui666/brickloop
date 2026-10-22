import { Button, Select, Tooltip, Dropdown, ConfigProvider } from 'antd';
import { useShallow } from 'zustand/react/shallow';
import {
  MousePointer2,
  Move,
  RotateCw,
  EyeOff,
  Pipette,
  Undo2,
  Redo2,
  Bot,
  Grid2X2,
  Ruler,
  Axis3D,
  Crosshair,
  Proportions,
  ListFilter,
  Magnet,
  ShieldAlert,
  Waypoints,
  ChevronDown,
  ClipboardCheck,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { documentSession, runEditorAction, setEditorOption, useDocumentStore } from './document-store';
import { shortcutText, usePreferences } from './preferences-store';
import { useTranslation } from './store';
import { useAssemblyStore, setAssemblyOption, openChecks } from './assembly-store';

function Option({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Tooltip title={title} mouseEnterDelay={0.4}>
      <div className="toolbar-option">
        {icon}
        {children}
      </div>
    </Tooltip>
  );
}
export function EditorToolbar() {
  usePreferences((s) => s.value.shortcuts);
  const t = useTranslation(),
    state = useDocumentStore();
  const assembly = useAssemblyStore(
    useShallow((state) => ({
      snap: state.snap,
      collision: state.collision,
      policy: state.policy,
      connectors: state.connectors,
      connectorScope: state.connectorScope,
    })),
  );
  const space = (
    <Option title={t('editor.space')} icon={<Axis3D />}>
      <Select
        className="space-select"
        aria-label={t('editor.space')}
        value={state.space}
        onChange={(value) => setEditorOption('space', value)}
        options={(['world', 'primaryLocal'] as const).map((value) => ({ value, label: t(`editor.spaces.${value}`) }))}
      />
    </Option>
  );
  return (
    <ConfigProvider componentDisabled={state.reviewBefore || !!state.locked}>
      <div className="toolbar" role="toolbar" aria-label={t('desktop.toolbarLabel')}>
        <div className="tool-group">
          {(
            [
              { key: 'select', icon: <MousePointer2 /> },
              { key: 'move', icon: <Move /> },
              { key: 'rotate', icon: <RotateCw /> },
            ] as const
          ).map(({ key, icon }) => (
            <Tooltip
              key={key}
              title={`${t(`desktop.toolbar.${key}`)} ${shortcutText(`tool.${key}`)}`}
              mouseEnterDelay={0.4}
            >
              <Button
                type="text"
                className={state.tool === key ? 'active-tool' : ''}
                aria-pressed={state.tool === key}
                aria-label={t(`desktop.toolbar.${key}`)}
                icon={icon}
                onClick={() => setEditorOption('tool', key)}
              />
            </Tooltip>
          ))}
        </div>
        <div className="tool-group tool-options">
          {state.tool === 'select' && (
            <Option icon={<ListFilter />} title={t('editor.selectionMode')}>
              <Select
                className="selection-mode"
                aria-label={t('editor.selectionMode')}
                value={state.selectionMode}
                onChange={(value) => setEditorOption('selectionMode', value)}
                options={(['default', 'color', 'type', 'both', 'connected'] as const).map((value) => ({
                  value,
                  label: t(`editor.modes.${value}`),
                }))}
              />
            </Option>
          )}
          {state.tool === 'move' && (
            <>
              <Option
                icon={<Grid2X2 />}
                title={`${t('structure.horizontalGrid')} ${['tool.grid1', 'tool.grid2', 'tool.grid3'].map(shortcutText).join(' / ')}`}
              >
                <Select
                  className="grid-select"
                  aria-label={t('desktop.toolbar.grid')}
                  value={state.horizontal}
                  onChange={(value) => setEditorOption('horizontal', value)}
                  options={[20, 10, 5].map((value) => ({ value, label: t(`desktop.viewport.gridSteps.${value}`) }))}
                />
              </Option>
              <Option
                icon={<Ruler />}
                title={`${t('editor.vertical')} ${['move.up', 'move.down'].map(shortcutText).join(' / ')}`}
              >
                <Select
                  className="vertical-select"
                  aria-label={t('editor.vertical')}
                  value={state.vertical}
                  onChange={(value) => setEditorOption('vertical', value)}
                  options={[8, 24, 1].map((value) => ({ value, label: t(`editor.verticalSteps.${value}`) }))}
                />
              </Option>
              {space}
            </>
          )}
          {state.tool === 'rotate' && (
            <>
              <Option
                icon={<Proportions />}
                title={`${t('editor.angle')} ${['rotate.left', 'rotate.right', 'rotate.up', 'rotate.down'].map(shortcutText).join(' / ')}`}
              >
                <Select
                  className="angle-select"
                  aria-label={t('editor.angle')}
                  value={state.angle}
                  onChange={(value) => setEditorOption('angle', value)}
                  options={[90, 45, 22.5, 15, 5, 1, 0].map((value) => ({
                    value,
                    label: value ? `${value}°` : t('editor.free'),
                  }))}
                />
              </Option>
              <Option icon={<Crosshair />} title={t('editor.pivot')}>
                <Select
                  className="pivot-select"
                  aria-label={t('editor.pivot')}
                  value={state.pivot}
                  onChange={(value) => setEditorOption('pivot', value)}
                  options={(['center', 'primary', 'connector'] as const).map((value) => ({
                    value,
                    label: t(`editor.pivots.${value}`),
                  }))}
                />
              </Option>
              {space}
            </>
          )}
        </div>
        <div className="tool-group fixed-tools">
          <Tooltip title={`${t('connectUi.snap')} ${shortcutText('tool.snap.toggle')}`}>
            <Button
              type="text"
              icon={<Magnet />}
              aria-label={t('connectUi.snap')}
              aria-pressed={assembly.snap}
              className={assembly.snap ? 'active-tool' : ''}
              onClick={() => setAssemblyOption('snap', !assembly.snap)}
            />
          </Tooltip>
          <Tooltip title={`${t('connectUi.collision')} ${shortcutText('tool.collision.toggle')}`}>
            <Button
              type="text"
              icon={<ShieldAlert />}
              aria-label={t('connectUi.collision')}
              aria-pressed={assembly.collision}
              className={assembly.collision ? 'active-tool' : ''}
              onClick={() => setAssemblyOption('collision', !assembly.collision)}
            />
          </Tooltip>
          <Dropdown
            menu={{
              selectable: true,
              selectedKeys: [assembly.policy],
              items: (['warn', 'block'] as const).map((value) => ({
                key: value,
                label: t(`connectUi.policies.${value}`),
                onClick: () => setAssemblyOption('policy', value),
              })),
            }}
            trigger={['click']}
          >
            <Button
              type="text"
              className="toolbar-dropdown"
              aria-label={t('connectUi.policy')}
              icon={<ChevronDown />}
            />
          </Dropdown>
          <Tooltip title={t('connectUi.connectors')}>
            <Button
              type="text"
              icon={<Waypoints />}
              aria-label={t('connectUi.connectors')}
              aria-pressed={assembly.connectors}
              className={assembly.connectors ? 'active-tool' : ''}
              onClick={() => setAssemblyOption('connectors', !assembly.connectors)}
            />
          </Tooltip>
          <Dropdown
            menu={{
              selectable: true,
              selectedKeys: [assembly.connectorScope],
              items: (['selection', 'visible'] as const).map((value) => ({
                key: value,
                label: t(`connectUi.connectorScopes.${value}`),
                onClick: () => setAssemblyOption('connectorScope', value),
              })),
            }}
            trigger={['click']}
          >
            <Button
              type="text"
              className="toolbar-dropdown"
              aria-label={t('connectUi.connectorScope')}
              icon={<ChevronDown />}
            />
          </Dropdown>
          <Tooltip title={`${t('connectUi.checks')} ${shortcutText('check.run')}`}>
            <Button type="text" icon={<ClipboardCheck />} aria-label={t('connectUi.checks')} onClick={openChecks} />
          </Tooltip>
          <Tooltip title={`${t('desktop.toolbar.hide')} ${shortcutText('view.hide')}`}>
            <Button
              type="text"
              icon={<EyeOff />}
              aria-label={t('desktop.toolbar.hide')}
              disabled={!state.workspace.selection.length}
              onClick={() => runEditorAction('view.hide')}
            />
          </Tooltip>
          <Tooltip title={`${t('editor.eyedropper')} ${shortcutText('tool.eyedropper')}`}>
            <Button
              type="text"
              icon={<Pipette />}
              aria-label={t('editor.eyedropper')}
              className={state.eyedropper ? 'active-tool' : ''}
              onClick={() => useDocumentStore.setState({ eyedropper: !state.eyedropper })}
            />
          </Tooltip>
          <Tooltip
            title={`${t('desktop.commands.edit.undo.label')} ${documentSession.history.at(-1)?.label ?? ''} ${shortcutText('edit.undo')}`}
          >
            <Button
              type="text"
              icon={<Undo2 />}
              aria-label={t('desktop.commands.edit.undo.label')}
              disabled={!documentSession.canUndo}
              onClick={() => runEditorAction('edit.undo')}
            />
          </Tooltip>
          <Tooltip
            title={`${t('desktop.commands.edit.redo.label')} ${documentSession.redoHistory.at(-1)?.label ?? ''} ${shortcutText('edit.redo')}`}
          >
            <Button
              type="text"
              icon={<Redo2 />}
              aria-label={t('desktop.commands.edit.redo.label')}
              disabled={!documentSession.canRedo}
              onClick={() => runEditorAction('edit.redo')}
            />
          </Tooltip>
        </div>
        <div className="toolbar-end">
          <Tooltip title={`${t('desktop.inspector.ai.title')} ${shortcutText('ai.open')}`}>
            <Button className="ai-button" type="text" onClick={() => runEditorAction('ai.open')} icon={<Bot />}>
              {t('desktop.inspector.ai.title')}
            </Button>
          </Tooltip>
        </div>
      </div>
    </ConfigProvider>
  );
}
