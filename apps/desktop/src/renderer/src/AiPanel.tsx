import { AiTurnFailure, sendFailureKey } from './ai-failure';
import { usePreferences } from './preferences-store';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Select, Tag, Tooltip, message } from 'antd';
import {
  Bot,
  Send,
  Settings,
  ImagePlus,
  X,
  ChevronRight,
  ChevronDown,
  CircleCheck,
  LoaderCircle,
  CircleX,
} from 'lucide-react';
import { resolveContext } from '@brickloop/core';
import { mutationNames } from '@brickloop/ai';
import type { ImageBlock, ToolResult, ToolName, ValidationIssue } from '@brickloop/ai';
import type { SavedTurn } from '../../shared/ai-api';
import { ReviewList } from './ReviewPanel';
import { AiTaskCard } from './AiTaskCard';
import { useTaskStore } from './ai-task-runtime';
import { useAiStore, aiChoice } from './ai-store';
import { MentionInput } from './MentionInput';
import type { MentionInputHandle } from './MentionInput';
import { activeTab, documentSession, useDocumentStore, documentLocked } from './document-store';
import { useShellStore, useTranslation } from './store';
import { AiImages } from './AiImages';
import { ImageTaskPanel, ImageReport } from './ImageTaskPanel';
import { openImageInput } from './ImageModelDialogs';
import { toolErrorKey } from './ai-tool-error';
import { AiContextBar } from './AiContextBar';
import { precheckLocalTurn, prepareShortcutStatistics, readContextMarks, saveLocalTurn } from './ai-integration';
import { precheckShortcut, splitLocalStatistics } from './ai-local-precheck';
import type { Shortcut } from './ai-local-precheck';
import { presetCapabilities } from '@brickloop/ai';
import { turnContextStatus } from './ai-context';
import type { ReactNode } from 'react';

function contextCards(cards: ReactNode[], cleared: boolean[], label: string) {
  const previous = cards.filter((_, index) => cleared[index]);
  return (
    <>
      {!!previous.length && (
        <details className="ai-context-previous" key={label}>
          <summary>{label}</summary>
          <div className="ai-context-cleared">{previous}</div>
        </details>
      )}
      {cards.filter((_, index) => !cleared[index])}
    </>
  );
}

function Inline({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
        .map((part, index) =>
          part.startsWith('**') ? (
            <strong key={index}>{part.slice(2, -2)}</strong>
          ) : part.startsWith('`') ? (
            <code key={index}>{part.slice(1, -1)}</code>
          ) : (
            part
          ),
        )}
    </>
  );
}
export function Markdown({ text }: { text: string }) {
  const blocks = text.split(/(```[\s\S]*?```)/g);
  return (
    <div className="ai-markdown">
      {blocks.map((block, index) =>
        block.startsWith('```') ? (
          <pre key={index}>{block.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')}</pre>
        ) : (
          block.split('\n').map((line, row) =>
            /^[-*] /.test(line) ? (
              <div className="ai-list-line" key={`${index}-${row}`}>
                • <Inline text={line.slice(2)} />
              </div>
            ) : /^#{1,3} /.test(line) ? (
              <strong className="ai-subtitle" key={`${index}-${row}`}>
                <Inline text={line.replace(/^#+ /, '')} />
              </strong>
            ) : (
              <p key={`${index}-${row}`}>
                <Inline text={line} />
              </p>
            ),
          )
        ),
      )}
    </div>
  );
}
function resultImages(result: ToolResult): ImageBlock[] {
  if (
    !result.ok ||
    !result.data ||
    typeof result.data !== 'object' ||
    Array.isArray(result.data) ||
    !Array.isArray(result.data.images)
  )
    return [];
  return result.data.images.filter(
    (v): v is ImageBlock =>
      !!v && typeof v === 'object' && !Array.isArray(v) && v.type === 'image' && typeof v.base64 === 'string',
  );
}
function UserMessage({ user }: { user: string }) {
  const t = useTranslation();
  const { prompt, attachment } = splitLocalStatistics(user);
  return (
    <>
      <p>{prompt}</p>
      {attachment && (
        <details className="ai-tool">
          <summary>
            <Tag>{t('aiUi.localStatistics.attached')}</Tag>
          </summary>
          <pre>{attachment}</pre>
        </details>
      )}
    </>
  );
}
function ToolActivity({ turn }: { turn: SavedTurn }) {
  const t = useTranslation();
  const calls = turn.events.filter((event) => event.type === 'tool_call');
  const retries = turn.events.filter((event) => event.type === 'retry').length;
  return (
    <div className="ai-activities">
      {retries > 0 && <p role="status">{t('aiFailure.retryCount', { count: retries })}</p>}
      {calls.map(({ call }) => {
        const output = turn.events.find((v) => v.type === 'tool_result' && v.call.id === call.id);
        const result = output?.type === 'tool_result' ? output.result : undefined;
        const allImages = result ? resultImages(result) : [];
        const images = call.name === 'compare_to_reference' ? allImages.slice(0, 2) : allImages;
        const data =
          result?.ok && result.data && typeof result.data === 'object' && !Array.isArray(result.data)
            ? result.data
            : {};
        const issues = (
          call.name === 'validate' && Array.isArray(data.issues)
            ? data.issues
            : result?.ok
              ? result.introducedIssues
              : []
        ) as ValidationIssue[];
        const changed =
          typeof data.changed === 'number'
            ? data.changed
            : Array.isArray(data.created)
              ? data.created.length
              : undefined;
        const checked = call.name === 'validate' || mutationNames.has(call.name as ToolName);
        const rows = Array.isArray(data.parts)
          ? data.parts
          : Array.isArray(data.colors)
            ? data.colors
            : Array.isArray(data.instances)
              ? data.instances
              : [];
        const detail = result?.ok
          ? [
              changed !== undefined ? t('aiUi.affected', { count: changed }) : '',
              data.emptyModel === true ? t('aiToolErrors.emptyForeground') : '',
              ...rows
                .slice(0, 30)
                .map((row) =>
                  row && typeof row === 'object' && !Array.isArray(row)
                    ? [row.nameZh, row.partId ?? row.id, row.colorId].filter(Boolean).join(' · ')
                    : '',
                ),
              ...issues.map(
                (issue) =>
                  `${t(`aiIssues.${issue.kind}`)} · ${Array.isArray(issue.paths) ? issue.paths.map((p) => (Array.isArray(p) ? String(p.at(-1)).slice(-6) : '')).join(' · ') : ''}`,
              ),
            ]
              .filter(Boolean)
              .join('\n') || t('aiUi.completed')
          : result
            ? t(toolErrorKey(result.code)) +
              (!result.ok &&
              result.code !== 'ENGINE_UNAVAILABLE' &&
              result.details &&
              typeof result.details === 'object' &&
              !Array.isArray(result.details) &&
              typeof result.details.line === 'number' &&
              typeof result.details.column === 'number'
                ? '\n' +
                  t('aiToolErrors.scriptDetails', {
                    line: result.details.line,
                    column: result.details.column,
                    message: result.message,
                  })
                : '')
            : t('aiUi.working');
        return (
          <div key={call.id}>
            <details className="ai-tool">
              <summary>
                <ChevronRight className="tool-closed" />
                <ChevronDown className="tool-open" />
                {!result ? <LoaderCircle /> : result.ok ? <CircleCheck /> : <CircleX />}
                <span className={!result ? 'ai-current' : ''}>
                  {t(`aiTools.${call.name}`)}
                  {changed !== undefined ? ` · ${t('aiUi.affected', { count: changed })}` : ''}
                </span>{' '}
                ·{' '}
                {result
                  ? result.ok
                    ? checked
                      ? issues.length === 0
                        ? t(call.name === 'validate' ? 'aiUi.checkPassed' : 'aiUi.noNewIssues')
                        : t(call.name === 'validate' ? 'aiUi.validationCheck' : 'aiUi.toolCheck', {
                            collisions: issues.filter((i) => i.kind === 'collision').length,
                            floating: issues.filter((i) => i.kind === 'floating').length,
                          })
                      : t('aiUi.completed')
                    : t('aiUi.toolFailed')
                  : t('aiUi.working')}
              </summary>
              <pre>{detail ?? t('aiUi.working')}</pre>
            </details>
            {!!images.length && <AiImages images={images} />}
          </div>
        );
      })}
    </div>
  );
}
export function AiPanel() {
  return (
    <Tooltip.UniqueProvider>
      <AiPanelContent />
    </Tooltip.UniqueProvider>
  );
}
function AiPanelContent() {
  const t = useTranslation(),
    state = useAiStore(),
    document = useDocumentStore(),
    tasks = useTaskStore((s) => s.tasks);
  const turns = state.turns.filter((turn) => !turn.documentId || turn.documentId === document.activeId);
  const marks = readContextMarks();
  const cleared = turns.map((turn) => marks.clearedTurnIds.includes(turn.id));
  const renderTurns = (render: (turn: SavedTurn) => ReactNode) =>
    contextCards(turns.map(render), cleared, t('aiContext.previous', { count: cleared.filter(Boolean).length }));
  const atLimit =
    Object.values(tasks).filter((v) => v.status === 'running').length >= (state.snapshot?.settings.concurrency ?? 3);
  const { provider: selectedProvider, model: selectedModel, effort } = aiChoice(state);
  const deepseekEffort = presetCapabilities(selectedProvider?.presetId, selectedModel).thinkingControl === 'deepseek';
  const [text, setText] = useState(''),
    [shortcut, setShortcut] = useState<Shortcut | null>(null),
    [sending, setSending] = useState(false),
    [images, setImages] = useState<ImageBlock[]>([]),
    [selection, setSelection] = useState(true),
    [context, setContext] = useState(true);
  const scroll = useRef<HTMLDivElement>(null),
    input = useRef<MentionInputHandle>(null);
  const followLatest = useRef(true);
  const sendPending = useRef(false);
  const providers = state.snapshot?.settings.providers ?? [];
  useEffect(() => {
    if (state.focusComposer) input.current?.focus();
  }, [state.focusComposer]);
  useEffect(() => {
    if (followLatest.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [state.turns]);
  useEffect(() => {
    if (document.reviewBefore) input.current?.blur();
  }, [document.reviewBefore]);
  async function attach(files: FileList | File[]) {
    const added: ImageBlock[] = [];
    for (const file of Array.from(files).slice(0, 8 - images.length)) {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 10_000_000) {
        useAiStore.setState({ error: 'aiUi.imageSize' });
        continue;
      }
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]!);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      added.push({ type: 'image', mime: file.type as ImageBlock['mime'], base64: data });
    }
    setImages((before) => [...before, ...added].slice(0, 8));
  }
  async function send(recheck?: SavedTurn) {
    if (sendPending.current || document.reviewBefore) return;
    if (documentLocked() || !selectedProvider || !selectedModel) return;
    if (!recheck && !text.trim() && !images.length) return;
    const prepared = recheck ? { text: recheck.user, mentions: [], removed: [] } : input.current!.prepare();
    if (prepared.removed.length) {
      void message.warning(t('askUi.removed', { names: prepared.removed.join('、') }));
      setText(prepared.text);
    }
    if (!prepared.text.trim() && !images.length) return;
    const user = prepared.text,
      attached = recheck ? [] : images,
      tab = activeTab(),
      checkedDocument = tab.session.document,
      paths = recheck?.local
        ? recheck.local.paths
        : shortcut && selection && document.workspace.selection.length
          ? document.workspace.selection.map((path) => [...path])
          : null,
      selected = recheck?.local?.selection ?? selection,
      modelContext = recheck?.local?.modelContext ?? context;
    const localShortcut =
      recheck || prepared.removed.length
        ? null
        : precheckShortcut(
            shortcut,
            user,
            {
              repair: t('aiUi.prompts.repair'),
              factory: t('aiUi.prompts.factory'),
              palette: t('aiUi.prompts.palette'),
              explain: t('aiUi.prompts.explain'),
            },
            attached,
            prepared.mentions,
          );
    sendPending.current = true;
    setSending(true);
    useAiStore.setState({ error: null });
    try {
      const statistics =
        localShortcut === 'palette' || localShortcut === 'explain'
          ? await prepareShortcutStatistics(localShortcut, paths, t, useShellStore.getState().language, tab)
          : null;
      const local =
        localShortcut && localShortcut !== 'explain'
          ? { shortcut: localShortcut, paths, selection: selected, modelContext }
          : null;
      const clean =
        local &&
        (local.shortcut === 'palette'
          ? statistics !== null && statistics.colorCount <= 1
          : await precheckLocalTurn(local, tab));
      // A tab switch must never send a delayed request to a different document.
      if (activeTab() !== tab || documentLocked() || useDocumentStore.getState().reviewBefore) return;
      if (clean && local && tab.session.document === checkedDocument) {
        const scope = paths ? t('aiUi.localCheck.selection', { count: paths.length }) : t('aiUi.localCheck.document');
        saveLocalTurn(
          user,
          t(`aiUi.localCheck.${local.shortcut}`, { scope, count: statistics?.colorCount ?? 0 }),
          local,
          tab,
        );
      } else
        await window.brickloop.aiStart({
          providerId: selectedProvider.id,
          model: selectedModel,
          effort,
          text: user + (tab.session.document === checkedDocument ? (statistics?.attachment ?? '') : ''),
          images: attached,
          selection: selected,
          modelContext,
          ...(paths
            ? {
                kind: 'selection' as const,
                selectionPaths: paths,
                scope: { paths },
              }
            : {}),
          mentions: prepared.mentions,
        });
      if (!recheck) {
        setText('');
        setShortcut(null);
        setImages([]);
      }
    } catch (error) {
      useAiStore.setState({ error: sendFailureKey(error) });
    } finally {
      sendPending.current = false;
      setSending(false);
    }
  }
  const activeName =
    resolveContext(document.document, documentSession.context)?.model.name ?? document.document.meta.title;
  return (
    <section
      className="ai-panel"
      aria-label={t('aiUi.title')}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void attach(e.dataTransfer.files);
      }}
    >
      <ImageTaskPanel />
      <div className="ai-panel-header">
        {selectedProvider?.type === 'chatgpt' && (
          <div className="ai-plan">
            <span>{t('aiUi.plan')}</span>
            <Button type="text" size="small" onClick={() => void window.brickloop.aiManageUsage()}>
              {t('aiUi.manageUsage')}
            </Button>
          </div>
        )}
        <div className="ai-provider-row">
          <Select
            aria-label={t('aiUi.provider')}
            placeholder={t('aiUi.chooseProvider')}
            value={selectedProvider?.id}
            disabled={document.reviewBefore}
            onChange={(id) => {
              useAiStore.setState({ selectedProvider: id ?? '', selectedModel: '' });
            }}
            options={providers.map((p) => ({ value: p.id, label: p.name }))}
          />
          <Tooltip title={t('aiUi.settings')}>
            <Button
              type="text"
              icon={<Settings />}
              aria-label={t('aiUi.settings')}
              onClick={() => {
                usePreferences.setState({ page: 'ai' });
                useAiStore.setState({ settingsOpen: true });
              }}
            />
          </Tooltip>
        </div>
        <div className="ai-model-row">
          <Select
            aria-label={t('aiUi.model')}
            showSearch
            value={selectedModel || null}
            disabled={document.reviewBefore}
            placeholder={t('aiUi.model')}
            onChange={(value: string | null) => {
              useAiStore.setState({ selectedProvider: selectedProvider?.id ?? '', selectedModel: value ?? '' });
            }}
            options={[...new Set([selectedProvider?.model ?? '', ...(selectedProvider?.models ?? [])])]
              .filter(Boolean)
              .map((id) => ({ label: id, value: id }))}
          />
          <Select
            aria-label={t('aiUi.depth')}
            value={effort}
            disabled={document.reviewBefore}
            onChange={(effort) => useAiStore.setState({ effort })}
            options={(['fast', 'balanced', 'deep'] as const).map((v) => ({
              value: v,
              label: t(`aiUi.${v}`),
              ...(deepseekEffort
                ? {
                    description: t(`aiUi.deepseekEffort.${v}`),
                    title: `${t(`aiUi.${v}`)}：${t(`aiUi.deepseekEffort.${v}`)}`,
                  }
                : {}),
            }))}
            {...(deepseekEffort
              ? {
                  popupMatchSelectWidth: false,
                  classNames: { popup: { root: 'ai-effort-popup' } },
                  optionRender: (option) => (
                    <div className="ai-effort-option">
                      <span>{option.label}</span>
                      <span className="ai-effort-description">{option.data.description}</span>
                    </div>
                  ),
                }
              : {})}
          />
        </div>
      </div>
      <div
        className="ai-message-list"
        ref={scroll}
        aria-live="polite"
        aria-busy={state.running}
        onScroll={(event) => {
          const list = event.currentTarget;
          followLatest.current = list.scrollHeight - list.clientHeight - list.scrollTop < 24;
        }}
      >
        {!turns.length && (
          <div className="empty-state">
            <Bot />
            <p>{t('aiUi.welcome')}</p>
            {!providers.length && (
              <Button
                onClick={() => {
                  usePreferences.setState({ page: 'ai' });
                  useAiStore.setState({ settingsOpen: true });
                }}
              >
                {t('aiUi.addProvider')}
              </Button>
            )}
          </div>
        )}
        {renderTurns((turn) => (
          <article className={tasks[turn.id] ? 'ai-turn ai-task-card' : 'ai-turn'} key={turn.id} data-task-id={turn.id}>
            {!turn.local && <AiTaskCard turn={turn} />}
            {!['queued', 'running'].includes(tasks[turn.id]?.status ?? '') &&
              (() => {
                const status = turnContextStatus(turn, marks);
                return !status.included && status.reason !== 'cleared' ? (
                  <Tooltip title={t(`aiContext.reasons.${status.reason}`)}>
                    <span className="ai-context-excluded" tabIndex={0}>
                      {t('aiContext.excluded')}
                    </span>
                  </Tooltip>
                ) : null;
              })()}
            <div className="ai-user">
              {turn.selectionCount !== undefined && <Tag>{t('askUi.selected', { count: turn.selectionCount })}</Tag>}
              <UserMessage user={turn.user} />
              {!!turn.images.length && <AiImages images={turn.images} />}
            </div>
            <div className="ai-assistant">
              <Markdown text={turn.text} />
              {turn.local && (
                <Button
                  size="small"
                  disabled={
                    sending || document.reviewBefore || !!document.locked || !selectedProvider || !selectedModel
                  }
                  onClick={() => void send(turn)}
                >
                  {t('aiUi.localCheck.recheck')}
                </Button>
              )}
              <ToolActivity turn={turn} />
              {turn.report && <ImageReport report={turn.report} />}
            </div>
            {turn.result && <AiTurnFailure result={turn.result} />}
          </article>
        ))}
        <ReviewList onContinue={() => input.current?.focus()} />
      </div>
      {state.error && (
        <Alert type="error" title={t(state.error)} closable onClose={() => useAiStore.setState({ error: null })} />
      )}
      <div className="ai-composer">
        <AiContextBar modelContext={context} draft={text} />
        <div className="ai-shortcuts">
          {(['repair', 'factory', 'palette', 'explain', 'reference'] as const).map((key) => (
            <Tooltip key={key} title={t(`aiUi.shortcuts.${key}`)}>
              <Button
                size="small"
                disabled={sending || document.reviewBefore}
                onClick={() => {
                  if (key === 'reference') {
                    if (
                      openImageInput(
                        images.map((image, index) => ({
                          name: `${t('aiUi.reference')} ${index + 1}`,
                          image,
                          view: 'auto',
                        })),
                      )
                    )
                      setImages([]);
                    return;
                  }
                  setText(t(`aiUi.prompts.${key}`));
                  setShortcut(key);
                  input.current?.focus();
                }}
              >
                {t(`aiUi.shortcuts.${key}`)}
              </Button>
            </Tooltip>
          ))}
        </div>
        <div className="ai-context">
          {selection && (
            <Tag closable onClose={() => setSelection(false)}>
              {t('aiUi.selected', { count: document.workspace.selection.length })}
            </Tag>
          )}
          {context && (
            <Tag closable onClose={() => setContext(false)} title={activeName}>
              {t('aiUi.context', { name: activeName })}
            </Tag>
          )}
        </div>
        {!!images.length && (
          <div className="ai-images">
            {images.map((img, i) => (
              <div key={i}>
                <img width="48" height="48" src={`data:${img.mime};base64,${img.base64}`} alt={t('aiUi.reference')} />
                <Button
                  size="small"
                  type="text"
                  icon={<X />}
                  aria-label={t('aiUi.removeImage')}
                  onClick={() => setImages(images.filter((_, n) => n !== i))}
                />
              </div>
            ))}
          </div>
        )}
        <MentionInput
          ref={input}
          label={t('aiUi.message')}
          disabled={sending || document.reviewBefore}
          value={text}
          placeholder={t(document.reviewBefore ? 'reviewUi.beforePlaceholder' : 'aiUi.placeholder')}
          onChange={(value) => {
            setText(value);
            setShortcut(null);
          }}
          onSend={() => void send()}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              void attach(e.clipboardData.files);
            }
          }}
        />
        <div className="ai-composer-actions">
          <label className="ai-attach" title={t('aiUi.attach')}>
            <ImagePlus size={16} />
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              aria-label={t('aiUi.attach')}
              onChange={(e) => {
                if (e.target.files) void attach(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
          <span>{t('aiUi.enterHint')}</span>
          <Button
            type="primary"
            icon={<Send />}
            loading={sending}
            disabled={
              sending ||
              document.reviewBefore ||
              !!document.locked ||
              !selectedProvider ||
              !selectedModel ||
              (!text.trim() && !images.length)
            }
            onClick={() => void send()}
          >
            {t(atLimit ? 'parallelUi.queue' : 'aiUi.send')}
          </Button>
        </div>
      </div>
    </section>
  );
}
