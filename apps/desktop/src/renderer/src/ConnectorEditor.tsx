import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Input, InputNumber, Select, Tooltip } from 'antd';
import { Copy, Plus, Trash2, Move, RotateCw, X, WandSparkles, Save, Link } from 'lucide-react';
import {
  CONNECTOR_TYPES,
  cloneConnector,
  ConnectorIndex,
  instantiateConnectors,
  isCompatible,
  parseConnectorFile,
  solveSnap,
  transformConnector,
} from '@brickloop/connect';
import type { Connector, ConnectorFile } from '@brickloop/connect';
import { CollisionWorld, IDENTITY_ROTATION, parseColliderOverride, isColliderShape } from '@brickloop/collide';
import type { ColliderShape, ColliderOverride } from '@brickloop/collide';
import { createDocument, createWorkspace, identity, invert, multiply, toLDraw, translation } from '@brickloop/core';
import { createViewport } from '@brickloop/viewport';
import type { Viewport, PartInstance } from '@brickloop/viewport';
import type { PartMesh, Transform } from '@brickloop/ldraw';
import { useAssemblyStore, loadAssemblyPart, replaceAssemblyPart } from './assembly-store';
import { previewShapes } from './assembly-engine';
import { getMesh } from './mesh-client';
import { useLibraryStore } from './library-store';
import { useTranslation } from './store';

const defaultConnector = (id: string): Connector => ({
  id,
  type: 'stud',
  frame: { origin: [0, 0, 0], axis: [0, -1, 0], ref: [1, 0, 0] },
});
export function ConnectorEditor() {
  const part = useAssemblyStore((state) => state.annotation);
  return part ? <AnnotationWindow key={part.id} partId={part.id} name={part.nameZh} /> : null;
}
function AnnotationWindow({ partId, name }: { partId: string; name: string }) {
  const t = useTranslation(),
    host = useRef<HTMLDivElement>(null),
    view = useRef<Viewport | null>(null);
  const [file, setFile] = useState<ConnectorFile | null>(null),
    [shapes, setShapes] = useState<ColliderShape[]>([]);
  const [version, setVersion] = useState(0),
    [approximate, setApproximate] = useState(false),
    [mesh, setMesh] = useState<PartMesh | null>(null);
  const [selected, setSelected] = useState(0),
    [selectedShape, setSelectedShape] = useState(0),
    [tab, setTab] = useState<'connectors' | 'colliders'>('connectors');
  const [tool, setTool] = useState<'move' | 'rotate'>('move'),
    [showProxy, setShowProxy] = useState(false);
  const [error, setError] = useState<string | null>(null),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const [inferred, setInferred] = useState<ConnectorFile | null>(null),
    [reference, setReference] = useState('ld:3001');
  const [trial, setTrial] = useState<PartInstance[]>([]),
    [ready, setReady] = useState(false);
  const fileRef = useRef(file);
  fileRef.current = file;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const base = useRef<Connector | null>(null);
  const colors = useLibraryStore((state) => state.allColors),
    color = colors.find((c) => c.ldrawCode === 71) ?? colors[0];
  const current = file?.connectors[selected];
  useEffect(() => {
    let active = true;
    void Promise.all([
      loadAssemblyPart(partId),
      getMesh(partId as `ld:${string}`, useLibraryStore.getState().status?.pack?.id ?? 'demo'),
    ])
      .then(([data, geometry]) => {
        if (!active) return;
        setFile({ ...structuredClone(data.connectors), status: 'draft' });
        setShapes(structuredClone(data.collider.shapes));
        setApproximate(data.collider.approximate);
        setVersion(data.overrideVersion);
        setMesh(geometry.mesh);
      })
      .catch(() => setError(t('annotation.loadFailed')));
    void createViewport(host.current!)
      .then((created) => {
        if (!active) {
          created.dispose();
          return;
        }
        view.current = created;
        created.setPreset('iso');
        created.syncDocument(createDocument(), createWorkspace(), colors);
        created.setEditorEvents({
          click() {},
          enter() {},
          box() {},
          place() {},
          context() {},
          connectorClick(marker) {
            const index = fileRef.current?.connectors.findIndex((c) => c.id === marker.ref.connectorId) ?? -1;
            if (index >= 0) setSelected(index);
            return true;
          },
          dragStart() {
            base.current = fileRef.current?.connectors[selectedRef.current] ?? null;
          },
          dragPreview(delta) {
            if (!base.current) return;
            const moved = transformConnector(base.current, new Float64Array(delta));
            setFile((value) =>
              value
                ? { ...value, connectors: value.connectors.map((c, i) => (i === selectedRef.current ? moved : c)) }
                : value,
            );
          },
          dragEnd(cancel) {
            if (cancel && base.current) {
              const original = base.current;
              setFile((value) =>
                value
                  ? { ...value, connectors: value.connectors.map((c, i) => (i === selectedRef.current ? original : c)) }
                  : value,
              );
            }
            base.current = null;
          },
        });
        setReady(true);
      })
      .catch(() => setError(t('desktop.viewport.error')));
    return () => {
      active = false;
      view.current?.dispose();
      view.current = null;
    };
  }, [partId]);
  useEffect(() => {
    if (!view.current || !mesh || !color) return;
    view.current.setParts([{ partId: partId as `ld:${string}`, mesh, color }, ...trial], colors);
    view.current.fitAll();
  }, [mesh, ready, trial]);
  useEffect(() => {
    if (!view.current || !file) return;
    if (!parseConnectorFile(file).file) return;
    const markers = instantiateConnectors({
      path: ['$annotation'],
      worldMatrix: identity(),
      connectors: file.connectors,
    }).map((marker) => ({
      ...marker,
      label: `${t(`connectorTypes.${marker.connector.type.replaceAll('.', '_')}`)} · ${name} · ${marker.ref.connectorId}`,
      ...(marker.ref.connectorId === current?.id ? { highlight: 'source' as const } : {}),
    }));
    view.current.setConnectors(markers);
    view.current.setColliderShapes(showProxy ? shapes.filter(isColliderShape) : []);
    view.current.setEditorSettings({
      tool,
      space: 'world',
      horizontal: 1,
      vertical: 1,
      angle: 5,
      pivot: current?.frame.origin ?? null,
      primaryMatrix: Array.from(identity()),
    });
  }, [file, current, tool, ready, showProxy, shapes]);
  function update(patch: Partial<Connector>) {
    setFile((value) =>
      value
        ? { ...value, connectors: value.connectors.map((c, i) => (i === selected ? { ...c, ...patch } : c)) }
        : value,
    );
    setMessage('');
  }
  function optional(field: keyof Connector, value: unknown) {
    if (!current) return;
    const next = { ...current, [field]: value };
    if (value === undefined) delete next[field];
    setFile((value) =>
      value ? { ...value, connectors: value.connectors.map((c, i) => (i === selected ? next : c)) } : value,
    );
  }
  function add(copy = false) {
    if (!file) return;
    let id = `point-${file.connectors.length + 1}`;
    while (file.connectors.some((c) => c.id === id)) id += '-1';
    setFile({
      ...file,
      connectors: [...file.connectors, copy && current ? { ...cloneConnector(current), id } : defaultConnector(id)],
    });
    setSelected(file.connectors.length);
  }
  async function infer() {
    setBusy(true);
    setError(null);
    try {
      setInferred(await window.brickloop.assemblyInfer(partId));
    } catch {
      setError(t('annotation.inferFailed'));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!file) return;
    const parsed = parseConnectorFile(file);
    if (!parsed.file) {
      setError(t('annotation.invalid', { fields: parsed.issues.map((i) => i.path).join('、') }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const collider: ColliderOverride = parseColliderOverride({
        schema: 1,
        version: version + 1,
        partId,
        approximate,
        shapes,
        notes: file.status,
      });
      const saved = await window.brickloop.assemblySave({
        connectors: { ...parsed.file, source: 'inferred+manual' },
        collider,
      });
      replaceAssemblyPart(partId, saved);
      setVersion(saved.overrideVersion);
      setMessage(t('annotation.saved', { status: t(`annotation.statuses.${file.status}`) }));
    } catch {
      setError(t('annotation.saveFailed'));
    } finally {
      setBusy(false);
    }
  }
  async function tryFit() {
    if (!file || !color) return;
    setBusy(true);
    setError(null);
    try {
      const data = await loadAssemblyPart(reference),
        geometry = await getMesh(reference as `ld:${string}`, useLibraryStore.getState().status?.pack?.id ?? 'demo');
      const targetMatrix = translation([110, 0, 0]);
      const target = instantiateConnectors({
        path: ['$reference'],
        worldMatrix: targetMatrix,
        connectors: data.connectors.connectors,
      });
      const source = current ?? file.connectors[0];
      const match = source && target.find((entry) => isCompatible(source, entry.connector).ok);
      if (!source || !match) {
        setMessage(t('annotation.noMatch'));
        setTrial([
          {
            partId: reference as `ld:${string}`,
            mesh: geometry.mesh,
            color,
            transform: toLDraw(targetMatrix) as Transform,
          },
        ]);
        return;
      }
      const initial = translation(
        match.connector.frame.origin.map((v, i) => v - source.frame.origin[i]!) as [number, number, number],
      );
      const result = solveSnap({
        selection: [{ path: ['$annotation'], worldMatrix: initial, connectors: file.connectors }],
        index: new ConnectorIndex([
          { path: ['$reference'], worldMatrix: targetMatrix, connectors: data.connectors.connectors },
        ]),
        config: { captureAngle: 180 },
      });
      const candidate = result.chosen;
      if (candidate) {
        const world = new CollisionWorld({
          instances: [{ path: ['$reference'], transform: targetMatrix, collider: data.collider }],
        });
        const edited = {
          connectors: file,
          collider: { ...data.collider, partId, shapes, approximate },
          overrideVersion: version,
        };
        const collision = world.query(
          { path: ['$annotation'], ...previewShapes(edited, new Float64Array(candidate.transform)) },
          { budgetMs: 20 },
        );
        candidate.collision = collision.status;
        // Keep the edited part fixed at its local origin; move the reference by the inverse solved pose.
        const relative = multiply(invert(new Float64Array(candidate.transform)), targetMatrix);
        setTrial([
          {
            partId: reference as `ld:${string}`,
            mesh: geometry.mesh,
            color: { ...color, rgb: '#3485ff', alpha: 0.6 },
            transform: toLDraw(relative) as Transform,
          },
        ]);
        setMessage(
          t('annotation.fitResult', {
            count: result.candidates.length,
            residual: candidate.constraint.residual.toFixed(3),
            collision: t(`connectUi.collisionStates.${candidate.collision}`),
          }),
        );
      } else {
        setTrial([]);
        setMessage(t('annotation.noMatch'));
      }
    } catch {
      setError(t('annotation.fitFailed'));
    } finally {
      setBusy(false);
    }
  }
  const label = (key: string) => t(`annotation.fields.${key}`);
  function vector(title: string, values: readonly number[], change: (value: [number, number, number]) => void) {
    return (
      <label className="annotation-field">
        <span>{title}</span>
        <div className="vector-input">
          {values.map((v, i) => (
            <InputNumber
              key={i}
              aria-label={`${title} ${['X', 'Y', 'Z'][i]}`}
              value={v}
              step={1}
              onChange={(n) => {
                if (n !== null) {
                  const next = [...values] as [number, number, number];
                  next[i] = n;
                  change(next);
                }
              }}
            />
          ))}
        </div>
      </label>
    );
  }
  const shape = shapes[selectedShape];
  function changeShape(patch: Partial<ColliderShape>) {
    if (shape)
      setShapes((values) => values.map((s, i) => (i === selectedShape ? ({ ...s, ...patch } as ColliderShape) : s)));
  }
  return (
    <div className="annotation-window" role="dialog" aria-modal="true" aria-label={t('annotation.title')}>
      <header className="annotation-header">
        <strong>
          {t('annotation.title')} · {name} <span className="secondary">{partId.slice(3)}</span>
        </strong>
        <div className="annotation-actions">
          <Select
            aria-label={t('annotation.status')}
            value={file?.status ?? 'draft'}
            onChange={(status) => setFile((value) => (value ? { ...value, status } : value))}
            options={(['draft', 'reviewed'] as const).map((value) => ({
              value,
              label: t(`annotation.statuses.${value}`),
            }))}
          />
          <Button type="primary" icon={<Save />} onClick={() => void save()} disabled={!file} loading={busy}>
            {t('annotation.save')}
          </Button>
          <Button
            type="text"
            icon={<X />}
            aria-label={t('annotation.close')}
            onClick={() => useAssemblyStore.setState({ annotation: null })}
          />
        </div>
      </header>
      <div className="annotation-toolbar">
        <Button icon={<WandSparkles />} loading={busy} onClick={() => void infer()}>
          {t('annotation.infer')}
        </Button>
        <Select
          aria-label={t('annotation.reference')}
          value={reference}
          onChange={setReference}
          options={[
            { value: 'ld:3001', label: t('annotation.references.brick') },
            { value: 'ld:3020', label: t('annotation.references.plate') },
            { value: 'ld:92690', label: t('annotation.references.bar') },
          ]}
        />
        <Button icon={<Link />} onClick={() => void tryFit()} loading={busy}>
          {t('annotation.tryFit')}
        </Button>
        <Checkbox checked={showProxy} onChange={(e) => setShowProxy(e.target.checked)}>
          {t('annotation.showProxy')}
        </Checkbox>
        <div className="tool-group">
          {(['move', 'rotate'] as const).map((value) => (
            <Tooltip key={value} title={t(`desktop.toolbar.${value}`)}>
              <Button
                type="text"
                icon={value === 'move' ? <Move /> : <RotateCw />}
                aria-label={t(`desktop.toolbar.${value}`)}
                className={tool === value ? 'active-tool' : ''}
                onClick={() => setTool(value)}
              />
            </Tooltip>
          ))}
        </div>
      </div>
      {error && <Alert type="error" title={error} closable onClose={() => setError(null)} />}
      <div className="annotation-body">
        <aside className="annotation-list">
          <Select
            aria-label={t('annotation.layer')}
            value={tab}
            onChange={setTab}
            options={['connectors', 'colliders'].map((value) => ({ value, label: t(`annotation.${value}`) }))}
          />
          <div className="annotation-list-actions">
            <Button
              type="text"
              icon={<Plus />}
              aria-label={t('annotation.add')}
              onClick={() =>
                tab === 'connectors'
                  ? add()
                  : (setShapes([
                      ...shapes,
                      { kind: 'box', center: [0, 0, 0], halfSize: [5, 5, 5], rotation: [...IDENTITY_ROTATION] },
                    ]),
                    setSelectedShape(shapes.length))
              }
            />
            {tab === 'connectors' && (
              <Button
                type="text"
                icon={<Copy />}
                aria-label={t('annotation.copy')}
                onClick={() => add(true)}
                disabled={!current}
              />
            )}
            <Button
              type="text"
              icon={<Trash2 />}
              aria-label={t('annotation.delete')}
              onClick={() => {
                if (tab === 'connectors') {
                  setFile((value) =>
                    value ? { ...value, connectors: value.connectors.filter((_, i) => i !== selected) } : value,
                  );
                  setSelected(0);
                } else {
                  setShapes(shapes.filter((_, i) => i !== selectedShape));
                  setSelectedShape(0);
                }
              }}
            />
          </div>
          <div className="annotation-list-scroll">
            {tab === 'connectors'
              ? file?.connectors.map((c, i) => (
                  <button className={selected === i ? 'selected' : ''} key={i} onClick={() => setSelected(i)}>
                    <span>{t(`connectorTypes.${c.type.replaceAll('.', '_')}`)}</span>
                    <small>{c.id}</small>
                  </button>
                ))
              : shapes.map((s, i) => (
                  <button key={i} className={selectedShape === i ? 'selected' : ''} onClick={() => setSelectedShape(i)}>
                    {t(`annotation.${s.kind}`)} {i + 1}
                  </button>
                ))}
          </div>
        </aside>
        <div className="annotation-viewport" ref={host} />
        <aside className="annotation-properties">
          <h2>{t('annotation.properties')}</h2>
          {tab === 'connectors' && current && (
            <>
              <label className="annotation-field">
                <span>{label('id')}</span>
                <Input value={current.id} onChange={(e) => update({ id: e.target.value })} />
              </label>
              <label className="annotation-field">
                <span>{label('type')}</span>
                <Select
                  value={current.type}
                  onChange={(type) => update({ type })}
                  options={CONNECTOR_TYPES.map((value) => ({
                    value,
                    label: t(`connectorTypes.${value.replaceAll('.', '_')}`),
                  }))}
                />
              </label>
              {(['origin', 'axis', 'ref'] as const).map((field) => (
                <div key={field}>
                  {vector(label(field), current.frame[field], (value) =>
                    update({ frame: { ...current.frame, [field]: value } }),
                  )}
                </div>
              ))}
              {(['length', 'diameter', 'studDepth'] as const).map((field) => (
                <label className="annotation-field" key={field}>
                  <span>{label(field)}</span>
                  <InputNumber
                    value={current[field] ?? null}
                    min={0}
                    onChange={(value) => optional(field, value ?? undefined)}
                  />
                </label>
              ))}
              <label className="annotation-field">
                <span>{label('rotation')}</span>
                <Select
                  value={current.rotation ?? 'free'}
                  onChange={(value) => update({ rotation: value })}
                  options={['free', 1, 5, 15, 22.5, 45, 90, 180].map((value) => ({
                    value,
                    label: value === 'free' ? t('editor.free') : `${value}°`,
                  }))}
                />
              </label>
              <label className="annotation-field">
                <span>{label('rotationValue')}</span>
                <InputNumber
                  value={typeof current.rotation === 'number' ? current.rotation : null}
                  min={0.001}
                  max={360}
                  onChange={(value) => optional('rotation', value ?? 'free')}
                />
              </label>
              {(['size', 'tag'] as const).map((field) => (
                <label className="annotation-field" key={field}>
                  <span>{label(field)}</span>
                  <Input value={current[field] ?? ''} onChange={(e) => optional(field, e.target.value || undefined)} />
                </label>
              ))}
              <label className="annotation-field">
                <span>{label('role')}</span>
                <Select
                  allowClear
                  value={current.role ?? null}
                  onChange={(value) => optional('role', value ?? undefined)}
                  options={[
                    { value: 'a', label: t('annotation.sideA') },
                    { value: 'b', label: t('annotation.sideB') },
                  ]}
                />
              </label>
              <div className="annotation-field">
                <span>{label('ends')}</span>
                <div className="vector-input">
                  {(['start', 'end'] as const).map((end) => (
                    <Select
                      key={end}
                      aria-label={t(`annotation.${end}`)}
                      value={current.ends?.[end] ?? 'open'}
                      onChange={(value) =>
                        update({ ends: { start: 'open', end: 'open', ...current.ends, [end]: value } })
                      }
                      options={['open', 'closed'].map((value) => ({ value, label: t(`annotation.${value}`) }))}
                    />
                  ))}
                </div>
              </div>
              {(['grid', 'cells', 'stops', 'limits'] as const).map((field) => (
                <JsonField
                  key={`${current.id}/${field}`}
                  title={label(field)}
                  value={current[field]}
                  change={(value) => optional(field, value)}
                  invalid={() => setError(t('annotation.invalidValue'))}
                />
              ))}
            </>
          )}
          {tab === 'colliders' && shape && (
            <>
              <label className="annotation-field">
                <span>{label('type')}</span>
                <Select
                  value={shape.kind}
                  onChange={(value) =>
                    setShapes(
                      shapes.map((s, i) =>
                        i === selectedShape
                          ? value === 'box'
                            ? { kind: 'box', center: s.center, halfSize: [5, 5, 5], rotation: [...IDENTITY_ROTATION] }
                            : { kind: 'cylinder', center: s.center, axis: [0, 1, 0], radius: 3, halfLength: 5 }
                          : s,
                      ),
                    )
                  }
                  options={['box', 'cylinder'].map((value) => ({ value, label: t(`annotation.${value}`) }))}
                />
              </label>
              {vector(label('origin'), shape.center, (center) => changeShape({ center }))}
              {shape.kind === 'box' ? (
                <>
                  {vector(label('halfSize'), shape.halfSize, (halfSize) => changeShape({ halfSize }))}
                  <JsonField
                    title={label('orientation')}
                    value={shape.rotation}
                    change={(value) =>
                      changeShape({ rotation: value as Extract<ColliderShape, { kind: 'box' }>['rotation'] })
                    }
                    invalid={() => setError(t('annotation.invalidValue'))}
                  />
                </>
              ) : (
                <>
                  {vector(label('axis'), shape.axis, (axis) => changeShape({ axis }))}
                  {(['radius', 'halfLength'] as const).map((field) => (
                    <label key={field} className="annotation-field">
                      <span>{label(field)}</span>
                      <InputNumber
                        value={shape[field]}
                        min={0.01}
                        onChange={(value) => {
                          if (value) changeShape({ [field]: value });
                        }}
                      />
                    </label>
                  ))}
                </>
              )}
              <Checkbox checked={approximate} onChange={(e) => setApproximate(e.target.checked)}>
                {t('annotation.approximate')}
              </Checkbox>
            </>
          )}
        </aside>
      </div>
      {inferred && (
        <div className="annotation-diff">
          <strong>{t('annotation.diff')}</strong>
          <span>
            {t('annotation.diffSummary', {
              before: file?.connectors.length ?? 0,
              after: inferred.connectors.length,
              changed: inferred.connectors.filter(
                (c) => JSON.stringify(c) !== JSON.stringify(file?.connectors.find((old) => old.id === c.id)),
              ).length,
            })}
          </span>
          <div className="diff-items">
            {inferred.connectors.map((c) => (
              <span key={c.id}>
                {c.id} · {t(`connectorTypes.${c.type.replaceAll('.', '_')}`)} · {c.frame.origin.join(', ')}
              </span>
            ))}
          </div>
          <Button
            onClick={() => {
              setFile({ ...inferred, status: 'draft' });
              setInferred(null);
              setSelected(0);
            }}
          >
            {t('annotation.applyInference')}
          </Button>
          <Button type="text" onClick={() => setInferred(null)}>
            {t('annotation.dismiss')}
          </Button>
        </div>
      )}
      <footer className="annotation-footer" role="status">
        {message || t('annotation.hint')}
      </footer>
    </div>
  );
}
function JsonField({
  title,
  value,
  change,
  invalid,
}: {
  title: string;
  value: unknown;
  change(value: unknown): void;
  invalid(): void;
}) {
  const [text, setText] = useState(value === undefined ? '' : JSON.stringify(value));
  return (
    <label className="annotation-field">
      <span>{title}</span>
      <Input.TextArea
        autoSize={{ minRows: 1, maxRows: 4 }}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          try {
            change(text.trim() ? (JSON.parse(text) as unknown) : undefined);
          } catch {
            invalid();
          }
        }}
      />
    </label>
  );
}
