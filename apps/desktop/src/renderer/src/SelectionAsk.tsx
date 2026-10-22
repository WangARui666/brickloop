import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button, Switch, message } from 'antd';
import { Bot, Send, X, LoaderCircle } from 'lucide-react';
import { documentSession, getViewport, useDocumentStore } from './document-store';
import { useAskStore, canAskSelection, openSelectionAsk } from './ask-store';
import { useAiStore, aiChoice } from './ai-store';
import { useTaskStore } from './ai-task-runtime';
import { usePreferences } from './preferences-store';
import { useTranslation } from './store';
import { MentionInput } from './MentionInput';
import type { MentionInputHandle } from './MentionInput';

export function SelectionAsk() {
  const t = useTranslation(),
    open = useAskStore((s) => s.open),
    ai = useAiStore(
      useShallow((s) => ({
        snapshot: s.snapshot,
        selectedProvider: s.selectedProvider,
        selectedModel: s.selectedModel,
        effort: s.effort,
      })),
    ),
    state = useDocumentStore(
      useShallow((s) => ({
        id: s.activeId,
        selection: s.workspace.selection,
        doc: s.document,
        locked: s.locked,
        before: s.reviewBefore,
        placement: s.placement,
        clipboard: s.clipboardPlacement,
        steps: s.stepViewing,
      })),
    ),
    tasks = useTaskStore((s) => s.tasks);
  const [text, setText] = useState(''),
    [locked, setLocked] = useState(true),
    [sending, setSending] = useState(false),
    [error, setError] = useState(false);
  const root = useRef<HTMLDivElement>(null),
    input = useRef<MentionInputHandle>(null);
  const choice = aiChoice(ai),
    eligible = canAskSelection();
  const pending = Object.values(tasks)
    .filter(
      (task) =>
        task.documentId === state.id &&
        task.kind === 'selection' &&
        ['queued', 'running'].includes(task.status) &&
        task.selectionBounds,
    )
    .slice(0, 3);
  useEffect(() => {
    useAskStore.setState({ open: false });
    setText('');
  }, [state.id]);
  useEffect(() => {
    if (!eligible) useAskStore.setState({ open: false });
  }, [eligible]);
  useEffect(() => {
    if (open) {
      setLocked(true);
      setError(false);
      if (input.current) input.current.focus();
      else root.current?.querySelector<HTMLElement>('.selection-ask-composer')?.focus();
    }
  }, [open]);
  useLayoutEffect(() => {
    // Position and reveal before the focus effect; subsequent projection bypasses React.
    const reposition = () => {
      const viewport = getViewport(),
        host = root.current?.parentElement;
      if (!viewport || !host || !root.current) return;
      const rect = host.getBoundingClientRect(),
        bounds = viewport.selectionBounds(useDocumentStore.getState().workspace.selection);
      const placed: { x: number; y: number; width: number; height: number }[] = [];
      for (const element of root.current.querySelectorAll<HTMLElement>('[data-ask-anchor]')) {
        const taskId = element.dataset.taskId,
          task = taskId ? useTaskStore.getState().tasks[taskId] : undefined;
        const box = task?.selectionBounds ?? bounds;
        const point = box
          ? ([(box[0] + box[3]) / 2, box[1], (box[2] + box[5]) / 2] as [number, number, number])
          : undefined;
        const visible = !!point && (!!taskId || canAskSelection());
        element.style.visibility = visible ? 'visible' : 'hidden';
        if (!point) continue;
        const projected = viewport.projectPoint(point),
          width = element.offsetWidth,
          height = element.offsetHeight;
        // Keep the control above all projected corners, including parts nearer the camera.
        for (const x of [box![0], box![3]])
          for (const y of [box![1], box![4]])
            for (const z of [box![2], box![5]]) projected.y = Math.min(projected.y, viewport.projectPoint([x, y, z]).y);
        const x = Math.max(8, Math.min(rect.width - width - 8, projected.x - rect.left - width / 2));
        let y = Math.max(46, Math.min(rect.height - height - 48, projected.y - rect.top - height - 16));
        for (const previous of placed)
          if (
            x < previous.x + previous.width + 6 &&
            x + width + 6 > previous.x &&
            y < previous.y + previous.height + 6 &&
            y + height + 6 > previous.y
          )
            y =
              previous.y - height - 6 >= 46
                ? previous.y - height - 6
                : Math.min(rect.height - height - 48, previous.y + previous.height + 6);
        if (Number.isFinite(x) && Number.isFinite(y))
          element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
        placed.push({ x, y, width, height });
      }
    };
    reposition();
    const timer = setInterval(reposition, 50);
    return () => clearInterval(timer);
  }, [open, state.selection, state.doc, tasks, eligible]);
  async function send() {
    if (sending || !canAskSelection() || !choice.provider || !choice.model || !text.trim()) return;
    const prepared = input.current!.prepare();
    if (prepared.removed.length) {
      void message.warning(t('askUi.removed', { names: prepared.removed.join('、') }));
      setText(prepared.text);
    }
    if (!prepared.text.trim()) return;
    const paths = structuredClone(documentSession.workspace.selection);
    setSending(true);
    setError(false);
    try {
      await window.brickloop.aiStart({
        providerId: choice.provider.id,
        model: choice.model,
        effort: choice.effort,
        text: prepared.text,
        images: [],
        selection: true,
        modelContext: true,
        kind: 'selection',
        selectionPaths: paths,
        ...(locked ? { scope: { paths } } : {}),
        mentions: prepared.mentions,
      });
      setText('');
      useAskStore.setState({ open: false });
      document.querySelector<HTMLElement>('.viewport-surface')?.focus();
    } catch {
      setError(true);
    } finally {
      setSending(false);
    }
  }
  return (
    <div className="selection-ask-layer" ref={root}>
      {eligible &&
        (open ? (
          <div
            className="selection-ask-composer"
            data-ask-anchor
            data-testid="selection-ask-input"
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.stopPropagation();
                useAskStore.setState({ open: false });
              }
            }}
          >
            <div className="selection-ask-heading">
              <Bot size={14} />
              <span>{t('askUi.selected', { count: state.selection.length })}</span>
              <small title={choice.model}>
                {choice.provider?.name} · {choice.model} · {t(`aiUi.${choice.effort}`)}
              </small>
              <button aria-label={t('askUi.close')} onClick={() => useAskStore.setState({ open: false })}>
                <X size={14} />
              </button>
            </div>
            {!choice.provider || !choice.model ? (
              <div className="selection-ask-setup">
                <span>{t('askUi.noProvider')}</span>
                <Button
                  size="small"
                  onClick={() => {
                    usePreferences.setState({ page: 'ai' });
                    useAiStore.setState({ settingsOpen: true });
                  }}
                >
                  {t('askUi.settings')}
                </Button>
              </div>
            ) : (
              <>
                <MentionInput
                  ref={input}
                  value={text}
                  onChange={setText}
                  singleLine
                  autoFocus
                  label={t('askUi.message')}
                  placeholder={t('askUi.placeholder', { count: state.selection.length })}
                  onSend={() => void send()}
                  onEscape={() => useAskStore.setState({ open: false })}
                  disabled={sending}
                />
                <div className="selection-ask-actions">
                  <label>
                    <Switch size="small" checked={locked} onChange={setLocked} aria-label={t('askUi.scope')} />
                    {t('askUi.scope')}
                  </label>
                  <Button
                    size="small"
                    type="text"
                    icon={<Send size={14} />}
                    loading={sending}
                    disabled={!text.trim()}
                    onClick={() => void send()}
                  >
                    {t('aiUi.send')}
                  </Button>
                </div>
              </>
            )}
            {error && (
              <span className="check-error" role="alert">
                {t('aiUi.failed')}
              </span>
            )}
          </div>
        ) : (
          <button
            className="selection-ask-button"
            data-ask-anchor
            data-testid="selection-ask-button"
            onClick={openSelectionAsk}
          >
            <Bot size={14} />
            {t('askUi.ask')}
            <kbd>Ctrl+K</kbd>
          </button>
        ))}
      {pending.map((task) => (
        <div
          className="selection-ask-status"
          data-ask-anchor
          data-task-id={task.taskId}
          data-testid="selection-ask-status"
          key={task.taskId}
          role="status"
        >
          <LoaderCircle size={13} />
          <span>{t(task.status === 'queued' ? 'askUi.queued' : 'askUi.working')}</span>
          <button onClick={() => void window.brickloop.aiStop(task.taskId)}>{t('aiUi.stop')}</button>
        </div>
      ))}
    </div>
  );
}
