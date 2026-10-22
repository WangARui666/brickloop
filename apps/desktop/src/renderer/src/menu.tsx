import { hasAnimationParts, openBuildAnimation } from './animation-host';
import { Check } from 'lucide-react';
import { Menu } from 'antd';
import type { MenuProps } from 'antd';
import { isLanguage } from '../../shared/api';
import { useShellStore, useTranslation } from './store';
import type { Viewport } from '@brickloop/viewport';
import { useLibraryStore } from './library-store';
import { useAssemblyStore, setMaintenance, openChecks } from './assembly-store';
import { availableEditorActions, documentSession, runEditorAction, useDocumentStore } from './document-store';
import { openDocuments, useProjectUi } from './project-controller';
import type { ExportFormat } from '../../shared/project-api';
import { useAiStore } from './ai-store';
import { openImageInput } from './ImageModelDialogs';
import { shortcutText, usePreferences } from './preferences-store';
import { documentLocked } from './document-store';

// All editing entries use the renderer's authoritative command bus.
export const commandGroups = {
  file: ['file.new', 'file.open', 'file.save', 'file.saveAs', 'file.close', 'file.import', 'file.export'],
  edit: [
    'macro.saveSelection',
    'edit.undo',
    'edit.redo',
    'edit.copy',
    'edit.cut',
    'edit.paste',
    'edit.delete',
    'edit.clone',
    'select.all',
    'select.clear',
    'select.sameColor',
    'select.sameType',
    'select.sameColorAndType',
    'select.connected',
    'select.invert',
  ],
  view: ['view.steps', 'view.hide', 'view.showOnly', 'view.showAll', 'view.fitAll', 'view.fitSelection', 'view.preset'],
  model: [
    'part.add',
    'transform.translate',
    'transform.rotate',
    'transform.set',
    'transform.snapToGrid',
    'color.set',
    'color.replace',
    'group.create',
    'group.dissolve',
    'group.rename',
    'group.enter',
    'group.exit',
    'submodel.create',
    'submodel.instantiate',
    'submodel.makeUnique',
    'submodel.explode',
    'submodel.rename',
    'submodel.enter',
    'submodel.exit',
    'step.add',
    'step.remove',
    'step.move',
    'step.assign',
  ],
  tools: ['macro.insert', 'tool.collision.toggle', 'tool.snap.toggle', 'tool.grid.set', 'check.run', 'ai.open'],
} as const;

export function MenuBar({ viewport }: { viewport: Viewport | null }) {
  const t = useTranslation();
  usePreferences((s) => s.value.shortcuts);
  const recent = useProjectUi((state) => state.recent);
  useDocumentStore((state) => state.document.revision);
  useDocumentStore((state) => state.workspace.selection.length);
  useDocumentStore((state) => state.locked);
  const reviewBefore = useDocumentStore((state) => state.reviewBefore);
  const language = useShellStore((state) => state.language);
  const maintenance = useAssemblyStore((state) => state.maintenance);
  const ready = useShellStore((state) => state.ready);
  const saving = useShellStore((state) => state.saving);
  const setLanguage = useShellStore((state) => state.setLanguage);
  const items: MenuProps['items'] = Object.entries(commandGroups).map(([group, commands]) => ({
    key: group,
    label: t(`menu.${group}`),
    children: commands.map((command) =>
      command === 'view.preset'
        ? {
            key: command,
            label: t('desktop.commands.view.preset.label'),
            disabled: !viewport,
            children: (['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'] as const).map((preset) => ({
              key: `preset:${preset}`,
              label: (
                <span className="command-label">
                  <span>{t(`desktop.viewport.presets.${preset}`)}</span>
                  <span className="shortcut">{shortcutText(`view.${preset}`)}</span>
                </span>
              ),
              onClick: () => viewport?.setPreset(preset),
            })),
          }
        : {
            key: command,
            disabled:
              command === 'macro.saveSelection'
                ? !documentSession.workspace.selection.length
                : command === 'edit.undo'
                  ? !documentSession.canUndo
                  : command === 'edit.redo'
                    ? !documentSession.canRedo
                    : !availableEditorActions.has(command),
            onClick: () => {
              runEditorAction(command);
            },
            label: (
              <span className="command-label">
                <span>
                  {t(`desktop.commands.${command}.label`)}
                  {command === 'edit.undo'
                    ? ` ${documentSession.history.at(-1)?.label ?? ''}`
                    : command === 'edit.redo'
                      ? ` ${documentSession.redoHistory.at(-1)?.label ?? ''}`
                      : ''}
                </span>
                <span className="shortcut">{shortcutText(command)}</span>
              </span>
            ),
          },
    ),
  }));
  const animationEnabled = hasAnimationParts(documentSession.document);
  const viewMenu = items.find((item) => item?.key === 'view');
  if (viewMenu && 'children' in viewMenu)
    viewMenu.children.push({
      key: 'view.animation',
      label: <span title={animationEnabled ? undefined : t('animationUi.empty')}>{t('animationUi.menu')}</span>,
      disabled: !animationEnabled,
      onClick: () => openBuildAnimation(),
    });
  const toolsMenu = items.find((item) => item?.key === 'tools');
  if (toolsMenu && 'children' in toolsMenu)
    toolsMenu.children.push(
      { key: 'image.generate', label: t('imageUi.menu'), disabled: documentLocked(), onClick: openImageInput },
      {
        key: 'mosaic.generate',
        label: t('mosaicUi.menu'),
        disabled: documentLocked(),
        onClick: () => useAiStore.setState({ mosaicOpen: true }),
      },
    );
  const fileMenu = items.find((item) => item?.key === 'file');
  if (fileMenu && 'children' in fileMenu) {
    fileMenu.children = fileMenu.children.filter((item) => item?.key !== 'file.export');
    fileMenu.children.push(
      {
        key: 'file.recent',
        label: t('files.recent'),
        disabled: !recent.length,
        children: recent.map((file) => ({ key: file, label: file, onClick: () => void openDocuments(file) })),
      },
      {
        key: 'file.export',
        label: t('desktop.commands.file.export.label'),
        children: [
          ...(['io', 'ldr', 'mpd', 'obj', 'dae', 'glb', 'csv', 'xlsx'] as ExportFormat[]).map((format) => ({
            key: `export:${format}`,
            label: t(`output.formats.${format}`),
            onClick: () => useProjectUi.setState({ exportFormat: format }),
          })),
          { key: 'file.pdf', label: t('instructionsUi.title'), onClick: () => usePreferences.setState({ pdf: true }) },
        ],
      },
    );
  }
  const modelMenu = items.find((item) => item?.key === 'model');
  if (modelMenu && 'children' in modelMenu)
    modelMenu.children.push({
      key: 'model.info',
      label: t('output.modelInfo'),
      onClick: () => runEditorAction('model.info'),
    });
  if (viewMenu && 'children' in viewMenu)
    viewMenu.children.push({
      key: 'view.screenshot',
      label: t('output.screenshot'),
      onClick: () => runEditorAction('view.screenshot'),
    });
  if (viewMenu && 'children' in viewMenu)
    viewMenu.children.push({
      key: 'projection',
      label: t('desktop.viewport.projection'),
      disabled: !viewport,
      children: (['perspective', 'ortho'] as const).map((mode) => ({
        key: `projection:${mode}`,
        label: t(`desktop.viewport.${mode}`),
        onClick: () => viewport?.setProjection(mode),
      })),
    });
  items.push({
    key: 'settings',
    label: t('libraryUi.settings'),
    children: [
      {
        key: 'settings.all',
        label: t('settingsUi.title'),
        onClick: () => {
          usePreferences.setState({ page: 'general' });
          useAiStore.setState({ settingsOpen: true });
        },
      },
      {
        key: 'ai.settings',
        label: t('aiUi.settings'),
        onClick: () => {
          usePreferences.setState({ page: 'ai' });
          useAiStore.setState({ settingsOpen: true });
        },
      },
      { key: 'packs', label: t('libraryUi.manage'), onClick: () => useLibraryStore.getState().openManager(true) },
      {
        key: 'maintenance',
        label: t('annotation.maintenance'),
        icon: maintenance ? <Check /> : <span className="menu-check-spacer" />,
        onClick: () => void setMaintenance(!maintenance),
      },
      { key: 'checks', label: `${t('connectUi.checks')} ${shortcutText('check.run')}`, onClick: openChecks },
    ],
  });
  items.push({
    key: 'help',
    label: t('menu.help'),
    children: [
      { key: 'about', label: t('aboutUi.title'), onClick: () => usePreferences.setState({ about: true }) },
      {
        key: 'language',
        label: t('desktop.language'),
        children: (['zh-CN', 'en'] as const).map((value) => ({
          key: value,
          label: t(`language.${value}`),
          disabled: !ready || saving,
          icon: language === value ? <Check /> : <span className="menu-check-spacer" />,
        })),
      },
    ],
  });

  if (reviewBefore)
    for (const item of items)
      if (
        item &&
        item.type !== 'divider' &&
        item.type !== 'group' &&
        ['file', 'edit', 'model', 'tools'].includes(String(item.key))
      )
        item.disabled = true;
  return (
    <Menu
      className="menu-bar"
      mode="horizontal"
      selectable={false}
      triggerSubMenuAction="click"
      disabledOverflow
      items={items}
      onClick={({ key }) => {
        if (isLanguage(key)) void setLanguage(key);
      }}
      aria-label={t('desktop.menuBar')}
    />
  );
}
