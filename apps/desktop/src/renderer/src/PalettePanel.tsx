import { useState } from 'react';
import { Button, Select, Tooltip, Alert } from 'antd';
import { Palette, Star } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { LibraryColor } from '../../shared/library-api';
import { useLibraryStore } from './library-store';
import { useShellStore, useTranslation } from './store';
import { chooseEditorColor, useDocumentStore } from './document-store';
import { expandInstances } from '@brickloop/core';

export function colorStyle(color: LibraryColor): CSSProperties {
  return { '--swatch-color': color.rgb, '--swatch-alpha': color.alpha } as CSSProperties;
}
function hue(color: LibraryColor) {
  const rgb = [1, 3, 5].map((index) => parseInt(color.rgb.slice(index, index + 2), 16) / 255);
  const [r, g, b] = rgb as [number, number, number];
  const max = Math.max(...rgb),
    min = Math.min(...rgb),
    delta = max - min;
  if (delta < 0.08) return -1 + max / 2;
  return ((max === r ? (g - b) / delta : max === g ? 2 + (b - r) / delta : 4 + (r - g) / delta) + 6) % 6;
}
function Swatches({ colors }: { colors: LibraryColor[] }) {
  const t = useTranslation();
  const language = useShellStore((state) => state.language);
  const { currentColor } = useLibraryStore();
  return (
    <div className="color-swatches">
      {colors.map((color) => (
        <Tooltip
          key={color.id}
          mouseEnterDelay={0.4}
          title={t('libraryUi.colorHint', {
            lego: color.legoName ?? t('libraryUi.customColor'),
            name: color.nameZh,
            factory: color.factoryCode ?? t('libraryUi.nonFactory'),
          })}
        >
          <button
            className={`color-swatch ${currentColor?.id === color.id ? 'selected' : ''}`}
            style={colorStyle(color)}
            aria-label={language === 'zh-CN' ? color.nameZh : (color.legoName ?? color.nameZh)}
            data-color-id={color.id}
            aria-pressed={currentColor?.id === color.id}
            onClick={() => chooseEditorColor(color)}
          />
        </Tooltip>
      ))}
    </div>
  );
}
export function PalettePanel() {
  const t = useTranslation();
  const language = useShellStore((state) => state.language);
  const { colors, allColors, favorites, currentColor, toggleFavorite, error } = useLibraryStore();
  useDocumentStore((state) => state.document.revision);
  const document = useDocumentStore.getState().document;
  const used = new Set(expandInstances(document).map((row) => row.colorId));
  const [sort, setSort] = useState('code');
  const sorted = [...colors].sort(
    sort === 'code'
      ? (a, b) => (a.factoryCode ?? '').localeCompare(b.factoryCode ?? '', 'en', { numeric: true })
      : (a, b) => hue(a) - hue(b),
  );
  const favoriteColors = favorites.flatMap((id) => {
    const color = allColors.find((entry) => entry.id === id);
    return color ? [color] : [];
  });
  return (
    <div className="palette-panel">
      <div className="palette-scroll">
        <section>
          <div className="palette-heading">
            <h3>{t('libraryUi.factoryColors')}</h3>
            <Select
              size="small"
              aria-label={t('libraryUi.sortColors')}
              value={sort}
              onChange={setSort}
              options={[
                { value: 'code', label: t('libraryUi.byCode') },
                { value: 'hue', label: t('libraryUi.byHue') },
              ]}
            />
          </div>
          <Swatches colors={sorted} />
        </section>
        <section>
          <h3>{t('libraryUi.projectColors')}</h3>
          {used.size ? (
            <Swatches colors={allColors.filter((color) => used.has(color.id))} />
          ) : (
            <div className="empty-state">
              <Palette />
              <p>{t('libraryUi.projectEmpty')}</p>
            </div>
          )}
        </section>
        <section>
          <h3>{t('libraryUi.favorites')}</h3>
          {favoriteColors.length ? (
            <Swatches colors={favoriteColors} />
          ) : (
            <div className="empty-state">
              <Star />
              <p>{t('libraryUi.favoritesEmpty')}</p>
            </div>
          )}
        </section>
        {error && <Alert type="error" title={t(`libraryUi.${error}`)} />}
      </div>
      {currentColor && (
        <div className="color-detail">
          <div className="current-color-heading">
            <span className="color-swatch large" style={colorStyle(currentColor)} />
            <div>
              {language === 'zh-CN' ? (
                <>
                  <strong lang="zh-CN" title={currentColor.nameZh}>
                    {currentColor.nameZh}
                  </strong>
                  <div
                    lang={currentColor.legoName === null ? language : 'en'}
                    title={currentColor.legoName ?? t('libraryUi.customColor')}
                  >
                    {currentColor.legoName ?? t('libraryUi.customColor')}
                  </div>
                </>
              ) : (
                <>
                  <strong lang="en" title={currentColor.legoName ?? t('libraryUi.customColor')}>
                    {currentColor.legoName ?? t('libraryUi.customColor')}
                  </strong>
                  <div lang="zh-CN" title={currentColor.nameZh}>
                    {currentColor.nameZh}
                  </div>
                </>
              )}
            </div>
            <Tooltip title={t(favorites.includes(currentColor.id) ? 'libraryUi.unfavorite' : 'libraryUi.favorite')}>
              <Button
                type="text"
                icon={<Star fill={favorites.includes(currentColor.id) ? 'currentColor' : 'none'} />}
                aria-label={t(favorites.includes(currentColor.id) ? 'libraryUi.unfavorite' : 'libraryUi.favorite')}
                onClick={() => void toggleFavorite(currentColor.id)}
              />
            </Tooltip>
          </div>
          <dl>
            <dt>{t('libraryUi.factoryCode')}</dt>
            <dd>{currentColor.factoryCode ?? t('libraryUi.nonFactory')}</dd>
            <dt>{t('libraryUi.material')}</dt>
            <dd>{t(`libraryUi.finishes.${currentColor.finish}`)}</dd>
          </dl>
        </div>
      )}
    </div>
  );
}
