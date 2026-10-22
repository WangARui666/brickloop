import { useEffect, useState } from 'react';
import { Alert, Input, Select, Tree } from 'antd';
import { createPortal } from 'react-dom';
import { Box, Search } from 'lucide-react';
import { macroName } from '@brickloop/io';
import type { PatternGroupId } from '@brickloop/catalog';
import type { MacroEntry } from '../../shared/macro-api';
import type { PatternPart } from '../../shared/library-api';
import { useShellStore, useTranslation } from './store';
import { useLibraryStore } from './library-store';
import { macroCategories, placeMacro, refreshMacros, useMacroStore } from './macro-store';
import { macroThumbnail } from './model-thumbnail';
import { VirtualParts } from './LibraryPanel';

function MacroTile({ entry }: { entry: MacroEntry }) {
  const t = useTranslation(),
    language = useShellStore((state) => state.language);
  const selected = useMacroStore((state) => state.selected);
  const paletteReady = useLibraryStore((state) => state.allColors.length > 0);
  const [image, setImage] = useState<string | null>(null),
    [failed, setFailed] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!paletteReady) return;
    let active = true;
    setImage(null);
    setFailed(false);
    void macroThumbnail(entry.id, entry.hash)
      .then((png) => {
        if (active) setImage(png);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [entry.id, entry.hash, paletteReady]);
  const name = macroName(entry.meta.name, language);
  return (
    <>
      <button
        type="button"
        className={`part-tile macro-tile ${selected === entry.id ? 'selected' : ''}`}
        data-macro-id={entry.id}
        aria-label={name}
        aria-pressed={selected === entry.id}
        title={`${name} · ${t('macroUi.parts', { count: entry.meta.partCount })}`}
        onClick={() => useMacroStore.setState({ selected: entry.id })}
        onDoubleClick={() => void placeMacro(entry.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          if (!entry.builtin) setMenu({ x: event.clientX, y: event.clientY });
        }}
        draggable
        onKeyDown={(event) => {
          if (event.key === 'Enter') void placeMacro(entry.id);
        }}
        onDragStart={(event) => {
          event.dataTransfer.setData('application/x-brickloop-macro', entry.id);
          event.dataTransfer.effectAllowed = 'copy';
        }}
      >
        <span className="part-image">
          {image ? (
            <img src={image} alt="" width={64} height={64} />
          ) : failed ? (
            <Box aria-label={t('libraryUi.geometryMissing')} />
          ) : (
            <span className="thumbnail-skeleton" aria-label={t('libraryUi.loading')} />
          )}
        </span>
        <span className="part-name">{name}</span>
      </button>
      {menu &&
        createPortal(
          <>
            <div className="context-dismiss" onPointerDown={() => setMenu(null)} />
            <div
              className="viewport-context-menu macro-context-menu"
              role="menu"
              style={{
                position: 'fixed',
                left: Math.min(menu.x, innerWidth - 252),
                top: Math.min(menu.y, innerHeight - 112),
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Escape') {
                  setMenu(null);
                } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  const buttons = [...event.currentTarget.querySelectorAll('button')];
                  const index = buttons.findIndex((button) => button === document.activeElement);
                  buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
                } else if (event.key === 'Tab') {
                  setMenu(null);
                }
              }}
            >
              <button
                role="menuitem"
                autoFocus
                onClick={() => {
                  setMenu(null);
                  useMacroStore.setState({ rename: entry });
                }}
              >
                {t('macroUi.rename')}
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  void window.brickloop
                    .macroReveal(entry.id)
                    .catch(() => useMacroStore.setState({ error: t('macroUi.loadFailed') }));
                }}
              >
                {t('macroUi.reveal')}
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  useMacroStore.setState({ remove: entry });
                }}
              >
                {t('macroUi.delete')}
              </button>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

export function MacroPanel() {
  const t = useTranslation(),
    language = useShellStore((state) => state.language);
  const state = useMacroStore(),
    { status, revision } = useLibraryStore();
  const [groups, setGroups] = useState<{ groupId: PatternGroupId; count: number }[]>([]);
  const [parts, setParts] = useState<PatternPart[]>([]),
    [searching, setSearching] = useState(false);
  const pattern = state.category.startsWith('patterns');
  useEffect(() => {
    void refreshMacros();
  }, []);
  useEffect(() => {
    if (status?.state !== 'ready') return;
    let active = true;
    void window.brickloop
      .patternGroups()
      .then((value) => {
        if (active) setGroups(value);
      })
      .catch(() => useMacroStore.setState({ error: t('macroUi.loadFailed') }));
    return () => {
      active = false;
    };
  }, [status, revision]);
  useEffect(() => {
    if (!pattern || status?.state !== 'ready') return;
    let active = true;
    setSearching(true);
    const timer = setTimeout(() => {
      void window.brickloop
        .patternSearch(state.query, groups.find((g) => `patterns:${g.groupId}` === state.category)?.groupId)
        .then((value) => {
          if (active) {
            setParts(value);
            setSearching(false);
          }
        })
        .catch(() => {
          if (active) {
            setSearching(false);
            useMacroStore.setState({ error: t('macroUi.loadFailed') });
          }
        });
    }, 120);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [state.query, state.category, pattern, groups, status, revision]);
  const categories = [...new Set([...macroCategories, ...state.entries.map((entry) => entry.meta.category)])];
  const matches = (entry: MacroEntry) =>
    !state.query.trim() ||
    [
      macroName(entry.meta.name, language),
      macroName(entry.meta.name, 'en'),
      macroName(entry.meta.name),
      entry.meta.category,
    ]
      .join(' ')
      .toLowerCase()
      .includes(state.query.trim().toLowerCase());
  const entries = state.entries.filter(
    (entry) => matches(entry) && (state.category === 'all' || entry.meta.category === state.category),
  );
  return (
    <div className="panel-body macro-body" data-testid="macro-panel">
      <Input
        prefix={<Search />}
        allowClear
        value={state.query}
        maxLength={200}
        placeholder={t('macroUi.search')}
        aria-label={t('macroUi.search')}
        onChange={(event) => useMacroStore.setState({ query: event.target.value })}
      />
      <div className="macro-insert-mode">
        <span>{t('macroUi.insertAs')}</span>
        <Select
          aria-label={t('macroUi.insertAs')}
          value={state.mode}
          disabled={pattern}
          onChange={(mode) => useMacroStore.setState({ mode })}
          options={(['group', 'submodel'] as const).map((value) => ({ value, label: t(`macroUi.${value}`) }))}
        />
      </div>
      <div className="category-tree macro-categories">
        <Tree
          blockNode
          selectedKeys={[state.category]}
          defaultExpandedKeys={['patterns']}
          onSelect={(keys) => {
            if (keys[0]) useMacroStore.setState({ category: String(keys[0]) });
          }}
          treeData={[
            { key: 'all', title: t('macroUi.all') },
            ...categories.map((category) => ({
              key: category,
              title: t(`macro.categories.${category}`, { defaultValue: category }),
            })),
            {
              key: 'patterns',
              title: t('macroUi.patterns'),
              children: groups.map((group) => ({
                key: `patterns:${group.groupId}`,
                title: t(`catalog.patterns.groups.${group.groupId}`),
              })),
            },
          ]}
        />
      </div>
      {state.error && (
        <Alert type="error" title={state.error} closable onClose={() => useMacroStore.setState({ error: null })} />
      )}
      <div className="result-count">
        {pattern ? t('libraryUi.results', { count: parts.length }) : t('macroUi.results', { count: entries.length })}
      </div>
      {pattern ? (
        searching ? (
          <div className="empty-state">
            <Search />
            <p>{t('libraryUi.searching')}</p>
          </div>
        ) : (
          <VirtualParts parts={parts} printed />
        )
      ) : (
        <div className="macro-grid">
          {entries.map((entry) => (
            <MacroTile key={entry.id} entry={entry} />
          ))}
          {!entries.length && (
            <div className="empty-state">
              <Search />
              <p>{t('libraryUi.noResults')}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
