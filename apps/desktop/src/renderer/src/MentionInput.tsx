import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import type { ClipboardEvent, KeyboardEvent } from 'react';
import type { Mention } from '../../shared/ai-api';
import { mentionCandidates, mentionTokens, resolveMentions, reconcileMentionTokens } from './ai-mentions';
import type { MentionToken } from './ai-mentions';
import { useDocumentStore } from './document-store';
import { useLibraryStore } from './library-store';
import { useShellStore, useTranslation } from './store';

export interface MentionInputHandle {
  focus(): void;
  blur(): void;
  prepare(): ReturnType<typeof resolveMentions>;
}
interface Props {
  value: string;
  onChange(value: string): void;
  onSend(): void;
  onEscape?(): void;
  onPaste?(event: ClipboardEvent<HTMLTextAreaElement>): void;
  label: string;
  placeholder: string;
  singleLine?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
}
export const MentionInput = forwardRef<MentionInputHandle, Props>(function MentionInput(props, ref) {
  const t = useTranslation(),
    state = useDocumentStore(),
    colors = useLibraryStore((s) => s.allColors),
    language = useShellStore((s) => s.language);
  const candidates = mentionCandidates(state.document, state.workspace.activeModelPath, state.workspace.selection, {
    selection: t('askUi.selection'),
    step: (n) => t('askUi.step', { n }),
    color: (id) => {
      const c = colors.find((v) => v.id === id);
      return (language === 'zh-CN' ? c?.nameZh : c?.legoName) ?? id;
    },
  });
  const input = useRef<HTMLTextAreaElement>(null),
    backdrop = useRef<HTMLDivElement>(null),
    known = useRef<Mention[]>([]),
    bindings = useRef<MentionToken[]>([]),
    previousText = useRef(props.value),
    composing = useRef(false);
  bindings.current = reconcileMentionTokens(previousText.current, props.value, bindings.current);
  previousText.current = props.value;
  const [query, setQuery] = useState<{ start: number; end: number; text: string } | null>(null),
    [index, setIndex] = useState(0),
    [below, setBelow] = useState(false);
  // Keep removed objects until send so their markers can be removed with an explanation.
  for (const candidate of candidates)
    if (!known.current.some((m) => m.type === candidate.type && m.id === candidate.id && m.name === candidate.name))
      known.current.push(candidate);
  useImperativeHandle(ref, () => ({
    focus: () => input.current?.focus(),
    blur: () => input.current?.blur(),
    prepare: () => resolveMentions(props.value, known.current, candidates, bindings.current),
  }));
  const filtered = query
    ? candidates.filter((m) => m.name.toLocaleLowerCase().includes(query.text.toLocaleLowerCase()))
    : [];
  const active = Math.min(index, Math.max(0, filtered.length - 1));
  function locate(value: string, cursor: number) {
    const before = value.slice(0, cursor),
      start = before.lastIndexOf('@');
    const text = before.slice(start + 1);
    const completed = mentionTokens(value, known.current, bindings.current).some(
      (token) => token.start === start && cursor > token.end,
    );
    setQuery(
      start >= 0 && !completed && !/[\n@]/u.test(text) && text.length <= 80 ? { start, end: cursor, text } : null,
    );
    const rect = input.current?.getBoundingClientRect(),
      viewportTop = input.current?.closest('.viewport')?.getBoundingClientRect().top ?? 0;
    const count = candidates.filter((m) => m.name.toLocaleLowerCase().includes(text.toLocaleLowerCase())).length;
    setBelow(!!rect && rect.top - viewportTop < Math.min(210, Math.max(40, count * 32 + 8)) + 45);
    setIndex(0);
  }
  function insert(mention: Mention) {
    if (!query) return;
    const marker = `@${mention.name} `,
      cursor = query.start + marker.length;
    const value = props.value.slice(0, query.start) + marker + props.value.slice(query.end);
    bindings.current = [
      ...reconcileMentionTokens(props.value, value, bindings.current),
      { start: query.start, end: cursor - 1, mention },
    ];
    previousText.current = value;
    props.onChange(value);
    setQuery(null);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(cursor, cursor);
    });
  }
  function key(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
    if (query && ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') setQuery(null);
      else if (event.key === 'ArrowUp' || event.key === 'ArrowDown')
        setIndex((active + (event.key === 'ArrowUp' ? -1 : 1) + filtered.length) % Math.max(1, filtered.length));
      else if (filtered[active]) insert(filtered[active]!);
      else setQuery(null);
      return;
    }
    if (event.key === 'Enter' && (!event.shiftKey || props.singleLine)) {
      event.preventDefault();
      props.onSend();
    } else if (event.key === 'Escape' && props.onEscape) {
      event.preventDefault();
      event.stopPropagation();
      props.onEscape();
    }
  }
  const tokens = mentionTokens(props.value, known.current, bindings.current),
    highlights = [];
  let end = 0;
  for (const token of tokens) {
    highlights.push(
      props.value.slice(end, token.start),
      <mark key={token.start}>{props.value.slice(token.start, token.end)}</mark>,
    );
    end = token.end;
  }
  highlights.push(props.value.slice(end), '\n');
  return (
    <div className={`mention-input ${props.singleLine ? 'mention-single' : ''}`}>
      <div ref={backdrop} className="mention-highlight" aria-hidden>
        {highlights}
      </div>
      <textarea
        ref={input}
        value={props.value}
        aria-label={props.label}
        placeholder={props.placeholder}
        disabled={props.disabled}
        rows={props.singleLine ? 1 : 3}
        autoFocus={props.autoFocus}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-controls={query ? `mention-list-${props.singleLine ? 'ask' : 'panel'}` : undefined}
        aria-activedescendant={
          query && filtered[active] ? `mention-${props.singleLine ? 'ask' : 'panel'}-${active}` : undefined
        }
        onChange={(e) => {
          props.onChange(props.singleLine ? e.target.value.replace(/\n/g, ' ') : e.target.value);
          if (!composing.current) locate(e.target.value, e.target.selectionStart);
        }}
        onClick={(e) => locate(e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={() => setQuery(null)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(e) => {
          composing.current = false;
          locate(e.currentTarget.value, e.currentTarget.selectionStart);
        }}
        onKeyDown={key}
        onPaste={props.onPaste}
        onScroll={() => {
          if (backdrop.current && input.current) {
            backdrop.current.scrollTop = input.current.scrollTop;
            backdrop.current.scrollLeft = input.current.scrollLeft;
          }
        }}
      />
      {query && (
        <div
          className={`mention-options ${below ? 'mention-below' : ''}`}
          role="listbox"
          id={`mention-list-${props.singleLine ? 'ask' : 'panel'}`}
          aria-label={t('askUi.references')}
        >
          {filtered.length ? (
            filtered.map((m, i) => (
              <button
                type="button"
                role="option"
                aria-selected={active === i}
                id={`mention-${props.singleLine ? 'ask' : 'panel'}-${i}`}
                key={`${m.type}:${m.id}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insert(m)}
              >
                <span>@{m.name}</span>
                <small>
                  {t(`askUi.types.${m.type}`)} · {m.count}
                </small>
              </button>
            ))
          ) : (
            <div className="mention-empty">{t('askUi.noReferences')}</div>
          )}
        </div>
      )}
    </div>
  );
});
