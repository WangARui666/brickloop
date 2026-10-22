import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Segmented, Tooltip, Tree, Dropdown } from 'antd';
import type { TreeDataNode } from 'antd';
import { Box, ChevronLeft, ChevronRight, Search, PackageOpen } from 'lucide-react';
import type { Category } from '@brickloop/catalog';
import type { LibraryPart, PatternPart } from '../../shared/library-api';
import { useShellStore, useTranslation } from './store';
import { useLibraryStore } from './library-store';
import { PanelResizeHandle } from './PanelResizeHandle';
import { markLibraryScroll, thumbnail } from './thumbnails';
import { startPlacement } from './document-store';
import { categoryRank } from './category-order';
import { useAssemblyStore } from './assembly-store';
import { escapeEditor } from './document-store';
import { MacroPanel } from './MacroPanel';

function PartTile({ part, printed = false }: { part: LibraryPart; printed?: boolean }) {
  const maintenance = useAssemblyStore((state) => state.maintenance);
  const t = useTranslation();
  const { selected, select, allColors, status } = useLibraryStore();
  const language = useShellStore((state) => state.language);
  const [image, setImage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const patternPart = printed ? (part as PatternPart) : null;
  const patternColor = printed
    ? allColors.find((color) => color.ldrawCode === (patternPart?.patternGroup === 'faces' ? 14 : 15))
    : undefined;
  useEffect(() => {
    let active = true;
    setImage(null);
    setFailed(false);
    if (status?.pack)
      void thumbnail(part, status.pack.id, allColors, () => active, patternColor)
        .then((png) => {
          if (active) {
            setImage(png);
            setFailed(!png);
          }
        })
        .catch(() => {
          if (active) setFailed(true);
        });
    return () => {
      active = false;
    };
  }, [part, allColors, status, patternColor]);
  return (
    <Dropdown
      trigger={['contextMenu']}
      menu={{
        items: maintenance
          ? [
              {
                key: 'connectors',
                label: t('annotation.edit'),
                onClick: () => {
                  escapeEditor();
                  useAssemblyStore.setState({ annotation: part });
                },
              },
            ]
          : [],
      }}
      disabled={!maintenance}
    >
      <Tooltip
        mouseEnterDelay={0.4}
        title={t('libraryUi.partHint', {
          name: part.nameZh,
          lego: part.legoNo ?? t('libraryUi.none'),
          factory: part.factoryNo ?? t('libraryUi.nonFactory'),
        })}
      >
        <button
          type="button"
          className={`part-tile ${selected?.id === part.id ? 'selected' : ''}`}
          data-part-id={part.id}
          aria-pressed={selected?.id === part.id}
          aria-label={part.nameZh}
          onClick={() => {
            select(part);
            if (patternColor) useLibraryStore.getState().chooseColor(patternColor);
            void startPlacement(part);
          }}
          onDoubleClick={() => {
            select(part);
            if (patternColor) useLibraryStore.getState().chooseColor(patternColor);
            void startPlacement(part);
          }}
          draggable
          onDragStart={(event) => {
            select(part);
            if (patternColor) useLibraryStore.getState().chooseColor(patternColor);
            event.dataTransfer.setData('text/plain', part.id);
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
          {patternPart && !patternPart.factory && (
            <span className="non-factory-badge">{t('aiIssues.non_factory_part')}</span>
          )}
          <span className="part-name">{language === 'zh-CN' ? part.nameZh : part.nameEn}</span>
        </button>
      </Tooltip>
    </Dropdown>
  );
}

export function VirtualParts({ parts, printed = false }: { parts: LibraryPart[]; printed?: boolean }) {
  const t = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ width: 250, height: 400, top: 0 });
  useEffect(() => {
    const element = host.current!;
    const observer = new ResizeObserver(() =>
      setLayout((previous) => ({ ...previous, width: element.clientWidth, height: element.clientHeight })),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (host.current) host.current.scrollTop = 0;
    setLayout((previous) => ({ ...previous, top: 0 }));
  }, [parts]);
  const columns = Math.max(1, Math.floor((layout.width + 8) / 84));
  const rowHeight = 120;
  const rows = Math.ceil(parts.length / columns);
  const first = Math.max(0, Math.floor(layout.top / rowHeight) - 2);
  const last = Math.min(rows, Math.ceil((layout.top + layout.height) / rowHeight) + 2);
  return (
    <div
      className="virtual-parts"
      ref={host}
      data-testid="part-grid"
      aria-label={t('desktop.library.grid')}
      onScroll={(event) => {
        markLibraryScroll();
        const top = event.currentTarget.scrollTop;
        setLayout((previous) => ({ ...previous, top }));
      }}
    >
      <div style={{ height: rows * rowHeight, position: 'relative' }}>
        {Array.from({ length: Math.max(0, last - first) }, (_, offset) => {
          const row = first + offset;
          return (
            <div key={row} className="part-row" style={{ top: row * rowHeight }}>
              {parts.slice(row * columns, (row + 1) * columns).map((part) => (
                <PartTile key={part.id} part={part} printed={printed} />
              ))}
            </div>
          );
        })}
      </div>
      {!parts.length && (
        <div className="empty-state">
          <Search />
          <p>{t('libraryUi.noResults')}</p>
        </div>
      )}
    </div>
  );
}
function categoryNodes(
  categories: Category[],
  parent: string | null,
  title: (category: Category) => string,
): TreeDataNode[] {
  return categories
    .filter((category) => category.parentId === parent)
    .sort((a, b) => categoryRank(a.id) - categoryRank(b.id) || a.order - b.order)
    .map((category) => ({
      key: category.id,
      title: title(category),
      children: categoryNodes(categories, category.id, title),
    }));
}
export function LibraryPanel() {
  const t = useTranslation();
  const { leftCollapsed: collapsed, leftWidth: width, toggleLeft: toggle, language, leftTab } = useShellStore();
  const { status, categories, revision, refresh, openManager, error } = useLibraryStore();
  const [query, setQuery] = useState('');
  const [includeAll, setIncludeAll] = useState(false);
  const [category, setCategory] = useState('all');
  const [parts, setParts] = useState<LibraryPart[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [categoryRatio, setCategoryRatio] = useState(35);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    setCategory('all');
  }, [revision]);
  useEffect(() => {
    if (status?.state !== 'ready') return;
    let active = true;
    setLoading(true);
    const timer = setTimeout(
      () => {
        void window.brickloop
          .catalogSearch(query, { includeAll, ...(category !== 'all' ? { categoryId: category } : {}) })
          .then((result) => {
            if (active) {
              setParts(result);
              setSearchError(false);
            }
          })
          .catch(() => {
            if (active) setSearchError(true);
          })
          .finally(() => {
            if (active) setLoading(false);
          });
      },
      query.trim() ? 150 : 0,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, includeAll, category, status, revision]);
  return (
    <aside
      className={`side-panel library-panel ${collapsed ? 'collapsed' : ''}`}
      aria-label={t('desktop.library.title')}
      id="library-panel"
      style={collapsed ? undefined : { width }}
    >
      <div className="panel-heading">
        {!collapsed && (
          <>
            <Segmented
              aria-label={t('macroUi.libraryTabs')}
              value={leftTab}
              onChange={(value) => useShellStore.setState({ leftTab: value as 'parts' | 'macros' })}
              options={[
                { value: 'parts', label: t('desktop.library.title') },
                { value: 'macros', label: t('macroUi.title') },
              ]}
            />
            {leftTab === 'parts' && (
              <button
                className="pack-badge"
                onClick={() => openManager(true)}
                disabled={status?.state !== 'ready'}
                title={t('libraryUi.manage')}
              >
                {status?.pack?.name ?? t('libraryUi.pack')}
              </button>
            )}
          </>
        )}
        <Tooltip title={t(collapsed ? 'desktop.panels.expandLibrary' : 'desktop.panels.collapseLibrary')}>
          <Button
            type="text"
            size="small"
            icon={collapsed ? <ChevronRight /> : <ChevronLeft />}
            aria-label={t(collapsed ? 'desktop.panels.expandLibrary' : 'desktop.panels.collapseLibrary')}
            aria-expanded={!collapsed}
            onClick={toggle}
          />
        </Tooltip>
      </div>
      {!collapsed && leftTab === 'macros' && <MacroPanel />}
      {!collapsed && leftTab === 'parts' && (
        <div className="panel-body library-body" data-library-ready={status?.state === 'ready' && !loading}>
          {status?.state === 'ready' ? (
            <>
              <div className="library-search">
                <Input
                  allowClear
                  prefix={<Search />}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('desktop.library.search')}
                  aria-label={t('desktop.library.search')}
                />
                <Segmented
                  size="small"
                  aria-label={t('libraryUi.showAll')}
                  value={includeAll ? 'all' : 'factory'}
                  onChange={(value) => setIncludeAll(value === 'all')}
                  options={[
                    { value: 'factory', label: t('editor.factoryParts') },
                    { value: 'all', label: t('editor.allParts') },
                  ]}
                />
              </div>
              <div className="category-tree" style={{ flexBasis: `${categoryRatio}%` }}>
                <Tree
                  blockNode
                  selectedKeys={[category]}
                  defaultExpandedKeys={['all']}
                  onSelect={(keys) => setCategory(String(keys[0] ?? 'all'))}
                  treeData={[
                    {
                      key: 'all',
                      title: t('desktop.library.all'),
                      children: categoryNodes(categories, null, (category) =>
                        language === 'en'
                          ? category.nameEn
                          : t(`libraryUi.categories.${category.id}`, { defaultValue: category.nameZh }),
                      ),
                    },
                  ]}
                />
              </div>
              <div
                className="category-resize"
                role="separator"
                aria-label={t('editor.resizeCategories')}
                aria-orientation="horizontal"
                aria-valuemin={15}
                aria-valuemax={65}
                aria-valuenow={categoryRatio}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    setCategoryRatio((value) =>
                      Math.max(15, Math.min(65, value + (event.key === 'ArrowDown' ? 2 : -2))),
                    );
                  }
                }}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                  const parent = event.currentTarget.parentElement!.getBoundingClientRect();
                  setCategoryRatio(
                    Math.max(15, Math.min(65, ((event.clientY - parent.top - 36) / parent.height) * 100)),
                  );
                }}
                onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
              />
              <div className="result-count" aria-live="polite">
                {loading ? t('libraryUi.searching') : t('libraryUi.results', { count: parts.length })}
              </div>
              {searchError ? <Alert type="error" title={t('libraryUi.loadFailed')} /> : <VirtualParts parts={parts} />}
            </>
          ) : (
            <div className="empty-state library-unavailable">
              <PackageOpen />
              <p>
                {t(
                  status?.state === 'missing'
                    ? 'libraryUi.missingLibrary'
                    : status?.state === 'error' || error
                      ? 'libraryUi.loadFailed'
                      : 'libraryUi.loading',
                )}
              </p>
              {status?.state === 'missing' && <code>pnpm ldraw:fetch</code>}
              {(status || error) && <Button onClick={() => void refresh()}>{t('desktop.retry')}</Button>}
            </div>
          )}
        </div>
      )}
      {!collapsed && <PanelResizeHandle side="left" />}
    </aside>
  );
}
