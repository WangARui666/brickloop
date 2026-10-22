import { useEffect, useState } from 'react';
import { Select } from 'antd';
import { Box } from 'lucide-react';
import { eulerDegrees, withEulerDegrees, fromPositionLdu, toPositionLdu } from '@brickloop/viewport';
import type { PositionUnit } from '@brickloop/viewport';
import { expandInstances, pathStartsWith, resolvePath, toLDraw } from '@brickloop/core';
import type { Vec3 } from '@brickloop/core';
import type { LibraryPart } from '../../shared/library-api';
import { dispatchEdit, useDocumentStore } from './document-store';
import { useLibraryStore } from './library-store';
import { useShellStore, useTranslation } from './store';
import { thumbnail } from './thumbnails';
import { colorStyle } from './PalettePanel';
import { usePreferences } from './preferences-store';

function NumberField({
  value,
  label,
  suffix,
  onCommit,
}: {
  value: number;
  label: string;
  suffix: string;
  onCommit(value: number): void;
}) {
  const [text, setText] = useState(String(Number(value.toFixed(4))));
  useEffect(() => setText(String(Number(value.toFixed(4)))), [value]);
  function commit() {
    const number = Number(text);
    if (text.trim() && Number.isFinite(number) && Math.abs(number - value) > 1e-8) onCommit(number);
    else setText(String(Number(value.toFixed(4))));
  }
  return (
    <span className="number-field">
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            setText(String(Number(value.toFixed(4))));
            event.stopPropagation();
          }
        }}
      />
      <span className="number-suffix">{suffix}</span>
    </span>
  );
}
export function PropertiesPanel() {
  const t = useTranslation(),
    { document: doc, workspace } = useDocumentStore();
  const { allColors, status } = useLibraryStore(),
    language = useShellStore((state) => state.language);
  const preferredUnit = usePreferences((s) => s.value.unit);
  const [unit, setUnit] = useState<PositionUnit | 'cm'>(preferredUnit),
    [part, setPart] = useState<LibraryPart | null>(null),
    [image, setImage] = useState<string | null>(null);
  useEffect(() => setUnit(preferredUnit), [preferredUnit]);
  const path = workspace.selection.at(-1),
    resolved = path && resolvePath(doc, path);
  const id = resolved?.instance.ref.kind === 'part' ? resolved.instance.ref.partId : null;
  useEffect(() => {
    let active = true;
    setPart(null);
    setImage(null);
    if (id)
      void window.brickloop.catalogPart(id as LibraryPart['id']).then((part) => {
        if (active) setPart(part);
      });
    return () => {
      active = false;
    };
  }, [id]);
  useEffect(() => {
    let active = true;
    if (part && status?.pack)
      void thumbnail(part, status.pack.id, allColors, () => active).then((value) => {
        if (active) setImage(value);
      });
    return () => {
      active = false;
    };
  }, [part, status, allColors]);
  if (!resolved || !workspace.selection.length) return null;
  const matrix = toLDraw(resolved.worldMatrix),
    angles = eulerDegrees(matrix);
  const actualColor =
    resolved.instance.colorId === 'inherit'
      ? expandInstances(doc).find((row) => pathStartsWith(row.path, path!))?.colorId
      : resolved.instance.colorId;
  const color = allColors.find((color) => color.id === actualColor);
  function setPosition(axis: number, value: number) {
    const target = [...matrix];
    target[axis] = unit === 'cm' ? value * 25 : toPositionLdu(value, unit);
    dispatchEdit({ type: 'transform.set', transform: target, input: 'numeric' });
  }
  function setAngle(axis: number, value: number) {
    const target: [number, number, number] = [...angles];
    target[axis] = value;
    dispatchEdit({ type: 'transform.set', transform: withEulerDegrees(matrix, target as Vec3), input: 'numeric' });
  }
  return (
    <section className="properties-panel" aria-label={t('editor.properties')}>
      {workspace.selection.length === 1 && (
        <div className="property-part">
          {image ? <img src={image} width={64} height={64} alt="" /> : <Box />}
          <div>
            <strong>{part ? (language === 'zh-CN' ? part.nameZh : part.nameEn) : t('editor.submodel')}</strong>
            <div className="secondary">
              {part?.legoNo} {part?.factoryNo}
            </div>
          </div>
        </div>
      )}
      {color && (
        <div className="property-color">
          <span className="color-swatch" style={colorStyle(color)} />
          <span>
            {language === 'zh-CN' ? color.nameZh : color.legoName} · {color.factoryCode ?? t('libraryUi.nonFactory')}
          </span>
        </div>
      )}
      <div className="property-section-title">
        <span>{t('editor.position')}</span>
        <Select
          size="small"
          aria-label={t('editor.unit')}
          value={unit}
          onChange={setUnit}
          options={(['ldu', 'stud', 'plate', 'mm', 'cm'] as const).map((value) => ({
            value,
            label: t(`editor.units.${value}`),
          }))}
        />
      </div>
      <div className="property-fields">
        {['X', 'Y', 'Z'].map((axis, i) => (
          <label key={axis}>
            <span>{axis}</span>
            <NumberField
              label={`${t('editor.position')} ${axis}`}
              suffix={t(`editor.units.${unit}`)}
              value={unit === 'cm' ? matrix[i]! / 25 : fromPositionLdu(matrix[i]!, unit)}
              onCommit={(value) => setPosition(i, value)}
            />
          </label>
        ))}
      </div>
      <div className="property-section-title">
        <span>{t('editor.rotation')}</span>
      </div>
      <div className="property-fields">
        {['X', 'Y', 'Z'].map((axis, i) => (
          <label key={axis}>
            <span>{axis}</span>
            <NumberField
              label={`${t('editor.rotation')} ${axis}`}
              suffix="°"
              value={angles[i]!}
              onCommit={(value) => setAngle(i, value)}
            />
          </label>
        ))}
      </div>
      <div className="property-meta secondary">
        {t('editor.step', { number: resolved.model.stepIds.indexOf(resolved.instance.stepId) + 1 })} ·{' '}
        {resolved.instance.groupId ? doc.groups[resolved.instance.groupId]?.name : resolved.model.name}
      </div>
    </section>
  );
}
