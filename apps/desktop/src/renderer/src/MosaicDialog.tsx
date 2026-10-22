import workerUrl from './mosaic.worker?worker&url';
import { createModuleWorker } from './module-worker';
import { useEffect, useRef, useState } from 'react';
import { Alert, Checkbox, InputNumber, Modal, Select, Spin } from 'antd';
import { ImagePlus } from 'lucide-react';
import { mosaicToOps } from '@brickloop/mosaic';
import type { MosaicResult, RgbaImage, Tile } from '@brickloop/mosaic';
import { resolveContext } from '@brickloop/core';
import { useTranslation } from './store';
import { useAiStore } from './ai-store';
import { useLibraryStore } from './library-store';
import { readImageFiles } from './AiImages';
import { decodeImage } from './ai-integration';
import { mosaicPalette, mosaicTiles } from './mosaic-catalog';
import {
  activeTab,
  documentLocked,
  documentSession,
  ensureDocumentMeshes,
  refresh,
  editorViewport,
} from './document-store';
import { loadAssemblyPart } from './assembly-store';

export function MosaicDialog() {
  const open = useAiStore((s) => s.mosaicOpen),
    library = useLibraryStore(),
    t = useTranslation();
  const [image, setImage] = useState<RgbaImage | null>(null),
    [width, setWidth] = useState(32),
    [height, setHeight] = useState(32),
    [ratio, setRatio] = useState(true);
  const [style, setStyle] = useState<'square' | 'round'>('square'),
    [dither, setDither] = useState(false),
    [merge, setMerge] = useState(true);
  const [tiles, setTiles] = useState<Tile[]>([]),
    [result, setResult] = useState<MosaicResult | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null),
    target = useRef(activeTab());
  useEffect(() => {
    if (!open) return;
    target.current = activeTab();
    let current = true;
    void (async () => {
      const [parts, catalog] = await Promise.all([
        window.brickloop.catalogSearch('', { includeAll: false }),
        window.brickloop.assemblyCatalog(),
      ]);
      const candidates = parts.filter((p) =>
        /^(Tile|Plate).*1 x 1|^Tile \d+ x \d+/i.test(p.nameEn.replace(/\s+/g, ' ').trim()),
      );
      const bounded = await Promise.all(
        candidates.map(async (p) => ({
          ...p,
          bboxLdu:
            p.bboxLdu ??
            ([...(await loadAssemblyPart(p.id)).collider.bounds] as [number, number, number, number, number, number]),
        })),
      );
      if (current) {
        const available = mosaicTiles(bounded, catalog);
        setTiles(available);
        if (!available.length) setError('mosaicUi.noTiles');
      }
    })().catch(() => {
      if (current) setError('mosaicUi.failed');
    });
    return () => {
      current = false;
    };
  }, [open, library.revision]);
  useEffect(() => {
    setResult(null);
    if (!open || !image || !tiles.length) return;
    const palette = mosaicPalette(library.colors, tiles, style);
    if (!palette.length) {
      setError('mosaicUi.noTiles');
      return;
    }
    setBusy(true);
    setError('');
    const worker = createModuleWorker(workerUrl);
    worker.onmessage = (event: MessageEvent<{ result?: MosaicResult; error?: string }>) => {
      setResult(event.data.result ?? null);
      setError(event.data.error ?? '');
      setBusy(false);
      worker.terminate();
    };
    worker.onerror = () => {
      setError('mosaicUi.failed');
      setBusy(false);
      worker.terminate();
    };
    worker.postMessage({ image, options: { width, height, style, dither, merge, tiles, palette } });
    return () => worker.terminate();
  }, [open, image, width, height, style, dither, merge, tiles, library.colors]);
  useEffect(() => {
    if (!result || !canvas.current) return;
    const scale = Math.max(1, Math.floor(320 / Math.max(result.width, result.height))),
      output = canvas.current;
    output.width = result.width * scale;
    output.height = result.height * scale;
    const ctx = output.getContext('2d')!,
      small = document.createElement('canvas');
    small.width = result.width;
    small.height = result.height;
    small
      .getContext('2d')!
      .putImageData(new ImageData(new Uint8ClampedArray(result.preview.data), result.width, result.height), 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, output.width, output.height);
    if (scale >= 4) {
      ctx.strokeStyle = getComputedStyle(output).getPropertyValue('--bl-border');
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= output.width; x += scale) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, output.height);
      }
      for (let y = 0; y <= output.height; y += scale) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(output.width, y + 0.5);
      }
      ctx.stroke();
    }
  }, [result]);
  async function attach(files: FileList | File[]) {
    try {
      const first = (await readImageFiles(files, 1))[0];
      if (!first) return;
      const decoded = await decodeImage(first.image);
      setImage(decoded);
      if (ratio) setHeight(Math.max(1, Math.min(256, Math.round((width * decoded.height) / decoded.width))));
    } catch {
      setError('aiUi.imageSize');
    }
  }
  function generate() {
    if (!result || busy || documentLocked() || target.current !== activeTab()) return;
    const model = resolveContext(documentSession.document, documentSession.context)?.model;
    if (!model) return;
    const insertion = mosaicToOps(result, {
      name: t('mosaicUi.modelName'),
      parentModelId: model.id,
      parentStepId: model.stepIds[0]!,
    });
    const applied = documentSession.applyExternal(insertion.ops, t('mosaicUi.transaction'), 'import');
    if (!applied.ok) {
      setError('mosaicUi.failed');
      return;
    }
    refresh();
    void ensureDocumentMeshes().then(() => editorViewport()?.fitAll());
    useAiStore.setState({ mosaicOpen: false });
  }
  return (
    <Modal
      title={t('mosaicUi.title')}
      open={open}
      width={640}
      className="mosaic-modal workflow-modal"
      okText={t('mosaicUi.generate')}
      cancelText={t('aiUi.cancel')}
      onCancel={() => useAiStore.setState({ mosaicOpen: false })}
      onOk={generate}
      okButtonProps={{ disabled: !result || busy || documentLocked() }}
    >
      <div
        className="mosaic-body"
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
        <div className="mosaic-controls">
          <label className="reference-picker">
            <ImagePlus />
            <span>{t('mosaicUi.choose')}</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              aria-label={t('mosaicUi.choose')}
              onChange={(e) => {
                if (e.target.files) void attach(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
          <small className="secondary">{t('mosaicUi.imageHint')}</small>
          <div className="mosaic-size">
            {(['width', 'height'] as const).map((axis) => (
              <label className="ai-form-field" key={axis}>
                {t(`imageUi.${axis}`)}
                <InputNumber
                  min={1}
                  max={256}
                  precision={0}
                  aria-label={t(`imageUi.${axis}`)}
                  value={axis === 'width' ? width : height}
                  onChange={(v) => {
                    const next = v ?? 32;
                    if (axis === 'width') {
                      setWidth(next);
                      if (ratio && image)
                        setHeight(Math.max(1, Math.min(256, Math.round((next * image.height) / image.width))));
                    } else {
                      setHeight(next);
                      if (ratio && image)
                        setWidth(Math.max(1, Math.min(256, Math.round((next * image.width) / image.height))));
                    }
                  }}
                />
              </label>
            ))}
          </div>
          <Checkbox
            checked={ratio}
            onChange={(e) => {
              setRatio(e.target.checked);
              if (e.target.checked && image)
                setHeight(Math.max(1, Math.min(256, Math.round((width * image.height) / image.width))));
            }}
          >
            {t('mosaicUi.lockRatio')}
          </Checkbox>
          <label className="ai-form-field">
            {t('mosaicUi.style')}
            <Select
              value={style}
              aria-label={t('mosaicUi.style')}
              options={['square', 'round'].map((value) => ({ value, label: t(`mosaicUi.${value}`) }))}
              onChange={setStyle}
            />
          </label>
          <Checkbox checked={dither} onChange={(e) => setDither(e.target.checked)}>
            {t('mosaicUi.dither')}
          </Checkbox>
          <Checkbox
            checked={merge && style === 'square'}
            disabled={style === 'round'}
            onChange={(e) => setMerge(e.target.checked)}
          >
            {t('mosaicUi.merge')}
          </Checkbox>
          <p className="secondary">{t('mosaicUi.paletteHint')}</p>
        </div>
        <div className="mosaic-preview">
          {busy && <Spin />}
          {result ? (
            <>
              <canvas ref={canvas} aria-label={t('mosaicUi.preview')} />
              <p>
                {t('mosaicUi.counts', {
                  parts: result.pieces.length,
                  colors: new Set(result.cells.map((c) => c.colorId)).size,
                })}
              </p>
            </>
          ) : (
            !busy && (
              <div className="empty-state">
                <ImagePlus />
                <p>{t('mosaicUi.empty')}</p>
              </div>
            )
          )}
        </div>
        {error && <Alert className="full-row" type="error" title={t(error)} />}
      </div>
    </Modal>
  );
}
