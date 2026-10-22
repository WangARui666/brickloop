import { useState } from 'react';
import { Alert, Button, Checkbox, Input, InputNumber, Modal, Select, Tag } from 'antd';
import { Plus, Pencil, Trash2, Plug, Star, ArrowLeft } from 'lucide-react';
import { getProviderPreset, matchProviderPreset, presetCapabilities, providerPresets } from '@brickloop/ai';
import type { ProviderPreset } from '@brickloop/ai';
import type { AiProvider, AiSnapshot } from '../../shared/ai-api';
import { providerConnectionStatus } from '../../shared/ai-api';
import type { ConnectionResult } from '../../shared/ai-setup';
import { useAiStore } from './ai-store';
import { useTranslation } from './store';
import chatgptLogo from './assets/chatgpt-logo-white.svg';

type Mode = 'choose' | 'account' | 'apiKey';
const updateSnapshot = (snapshot: AiSnapshot) => useAiStore.setState({ snapshot });
export function ConnectionFeedback({ result }: { result: ConnectionResult }) {
  const t = useTranslation();
  return (
    <div className="ai-connection-feedback" role="status">
      <Alert
        type={result.error ? (result.needsModel ? 'info' : 'error') : 'success'}
        title={
          result.error ? t(result.error) : t('aiSetup.connected', { ms: result.elapsedMs, count: result.models.length })
        }
        description={result.issue && !result.needsModel ? t(`aiSetup.advice.${result.issue}`) : undefined}
      />
      {(result.details || result.status) && (
        <details>
          <summary>{t('aiSetup.details')}</summary>
          {result.status && <p>{t('aiSetup.httpStatus', { status: result.status })}</p>}
          <pre>{result.details}</pre>
        </details>
      )}
    </div>
  );
}
function ModeChoices({ choose }: { choose: (mode: Mode) => void }) {
  const t = useTranslation();
  return (
    <div className="ai-mode-choices">
      {(['account', 'apiKey'] as const).map((mode) => (
        <Button key={mode} onClick={() => choose(mode)}>
          <strong>{t(`aiSetup.modes.${mode}`)}</strong>
          <span>{t(`aiSetup.modeHints.${mode}`)}</span>
        </Button>
      ))}
    </div>
  );
}
export function AiServices({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const state = useAiStore(),
    t = useTranslation();
  const [wizard, setWizard] = useState<{ mode: Mode; provider?: AiProvider } | null>(null);
  const [busy, setBusy] = useState(false),
    [results, setResults] = useState<Record<string, ConnectionResult | undefined>>({});
  const settings = state.snapshot!.settings;
  const disabled = busy || state.running;
  function open(mode: Mode, provider?: AiProvider) {
    if (provider) setResults((current) => ({ ...current, [provider.id]: undefined }));
    setWizard({ mode, ...(provider ? { provider } : {}) });
    onOpenChange(true);
  }
  function close() {
    setWizard(null);
    onOpenChange(false);
  }
  async function action(id: string, run: () => Promise<AiSnapshot>) {
    setBusy(true);
    setResults((current) => ({ ...current, [id]: undefined }));
    try {
      updateSnapshot(await run());
    } catch {
      setResults((current) => ({
        ...current,
        [id]: { models: [], model: '', elapsedMs: 0, error: 'aiUi.failed' },
      }));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="ai-section-title">
        <h3>{t('aiUi.providers')}</h3>
        {!!settings.providers.length && (
          <Button icon={<Plus />} size="small" disabled={disabled} onClick={() => open('choose')}>
            {t('aiUi.add')}
          </Button>
        )}
      </div>
      {!settings.providers.length && (
        <div className="ai-setup-empty">
          <p>{t('aiSetup.empty')}</p>
          <ModeChoices choose={open} />
        </div>
      )}
      <div className="ai-provider-list">
        {settings.providers.map((p) => {
          const account = state.snapshot?.accounts.find(
            (a) => a.id === (p.accountId ?? state.snapshot?.activeAccountId),
          );
          const status = providerConnectionStatus(p, state.snapshot!);
          const presetId = p.presetId ?? matchProviderPreset(p.type, p.endpoint);
          const presetName = presetId === 'chatgpt' ? '' : t(`aiPresets.${presetId}.name`);
          const result = results[p.id];
          return (
            <article className="ai-provider-item" key={p.id}>
              <div className="ai-provider-header">
                <strong>{p.name}</strong>
                <div className="ai-provider-actions">
                  <Button
                    type="text"
                    icon={<Plug />}
                    aria-label={t('aiUi.test', { name: p.name })}
                    title={t('aiUi.testConnection')}
                    disabled={disabled}
                    onClick={() => {
                      setBusy(true);
                      setResults((current) => ({ ...current, [p.id]: undefined }));
                      void window.brickloop
                        .aiTestProvider(p.id)
                        .then(async (value) => {
                          setResults((current) => ({ ...current, [p.id]: value }));
                          updateSnapshot(await window.brickloop.aiSnapshot());
                        })
                        .catch(() =>
                          setResults((current) => ({
                            ...current,
                            [p.id]: { models: [], model: '', elapsedMs: 0, error: 'aiUi.connectionFailed' },
                          })),
                        )
                        .finally(() => setBusy(false));
                    }}
                  />
                  {p.id === settings.defaultProviderId ? (
                    <span className="ai-provider-default" title={t('aiSetup.currentDefault')}>
                      <Star size={16} fill="currentColor" aria-hidden="true" />
                      {t('aiUi.default')}
                    </span>
                  ) : (
                    <Button
                      type="text"
                      icon={<Star />}
                      aria-label={t('aiUi.setDefault', { name: p.name })}
                      title={t('aiUi.setDefault', { name: p.name })}
                      disabled={disabled}
                      onClick={() =>
                        void action(p.id, () =>
                          window.brickloop.aiSaveSettings({ ...settings, defaultProviderId: p.id }),
                        )
                      }
                    />
                  )}
                  <Button
                    type="text"
                    icon={<Pencil />}
                    aria-label={t('aiUi.edit', { name: p.name })}
                    disabled={disabled}
                    onClick={() => open(p.type === 'chatgpt' ? 'account' : 'apiKey', p)}
                  />
                  <Button
                    type="text"
                    icon={<Trash2 />}
                    aria-label={t('aiUi.delete', { name: p.name })}
                    disabled={disabled}
                    onClick={() => void action(p.id, () => window.brickloop.aiDeleteProvider(p.id))}
                  />
                </div>
              </div>
              <div className="ai-provider-description">
                <div className="ai-provider-badges">
                  <Tag>{t(`aiSetup.modes.${p.type === 'chatgpt' ? 'account' : 'apiKey'}`)}</Tag>
                  <Tag
                    color={
                      status === 'available'
                        ? 'success'
                        : status === 'failed' || status === 'reauth' || status === 'reenter'
                          ? 'error'
                          : 'default'
                    }
                  >
                    {t(`aiSetup.status.${status}`)}
                  </Tag>
                  {presetName && presetName !== p.name.trim() && <span>{presetName}</span>}
                  <small>
                    {p.model || t('aiUi.noModel')}
                    {p.type !== 'chatgpt' && state.snapshot?.masks[p.id] ? ` · ${state.snapshot.masks[p.id]}` : ''}
                  </small>
                </div>
                {p.type === 'chatgpt' && (
                  <div className="ai-account-row">
                    {account?.signedIn && (
                      <Button
                        type="text"
                        className="ai-account-identity"
                        disabled={disabled}
                        onClick={() => void action(p.id, () => window.brickloop.aiAccount('select', account.id))}
                      >
                        {account.email ?? account.subject}
                        {state.snapshot?.activeAccountId === account.id ? ' ✓' : ''}
                      </Button>
                    )}
                    <div className="ai-account-actions">
                      <Button type="link" size="small" disabled={disabled} onClick={() => open('account', p)}>
                        {t(account?.signedIn ? 'aiUi.switchAccount' : 'aiUi.signInAgain')}
                      </Button>
                      {account?.signedIn && (
                        <Button
                          type="link"
                          size="small"
                          disabled={disabled}
                          onClick={() => void action(p.id, () => window.brickloop.aiAccount('signout', account.id))}
                        >
                          {t('aiUi.signout')}
                        </Button>
                      )}
                      <Button type="link" size="small" disabled={disabled} onClick={() => open('account')}>
                        {t('aiUi.addAccount')}
                      </Button>
                      <Button
                        type="link"
                        size="small"
                        onClick={() => void window.brickloop.aiManageUsage().catch(() => undefined)}
                      >
                        {t('aiUi.manageUsage')}
                      </Button>
                    </div>
                  </div>
                )}
                {p.modelsError && (
                  <div className="ai-provider-notice">
                    <span>{t(p.modelsError)}</span>
                    <Button
                      type="link"
                      size="small"
                      disabled={disabled}
                      onClick={() => void action(p.id, () => window.brickloop.aiRefreshModels(p.id))}
                    >
                      {t('aiUi.retryModels')}
                    </Button>
                  </div>
                )}
              </div>
              {result &&
                (result.error ? (
                  <ConnectionFeedback result={result} />
                ) : (
                  <p className="ai-provider-test-success" role="status">
                    {t('aiSetup.cardConnected', { ms: result.elapsedMs })}
                  </p>
                ))}
            </article>
          );
        })}
      </div>
      {wizard && <ProviderWizard initialMode={wizard.mode} initialProvider={wizard.provider} close={close} />}
    </>
  );
}
function ProviderWizard({
  initialMode,
  initialProvider,
  close,
}: {
  initialMode: Mode;
  initialProvider: AiProvider | undefined;
  close: () => void;
}) {
  const t = useTranslation(),
    state = useAiStore();
  const [mode, setMode] = useState(initialMode),
    [draft, setDraft] = useState<AiProvider | null>(initialProvider ?? null);
  const [key, setKey] = useState(''),
    [search, setSearch] = useState(''),
    [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false),
    [result, setResult] = useState<ConnectionResult | null>(
      initialProvider && providerConnectionStatus(initialProvider, state.snapshot!) === 'available'
        ? { models: initialProvider.models.map((id) => ({ id, name: id })), model: initialProvider.model, elapsedMs: 0 }
        : null,
    ),
    [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const settings = state.snapshot!.settings;
  const preset = draft
    ? getProviderPreset(draft.presetId ?? matchProviderPreset(draft.type, draft.endpoint))
    : undefined;
  const success = !!result && !result.error;
  const unreadableKey = !!draft && state.snapshot!.unreadableKeys.includes(draft.id);
  const missingReplacementKey = unreadableKey && !key.trim();
  const disabled = busy || state.running;
  const signedIn = state.snapshot?.accounts.filter((a) => a.signedIn) ?? [];
  function change(patch: Partial<AiProvider>) {
    if (draft) setDraft({ ...draft, ...patch });
    setResult(null);
    setError('');
  }
  function chooseMode(value: Mode) {
    setMode(value);
    setDraft(null);
    setKey('');
    setResult(null);
    setError('');
    setAdvanced(false);
  }
  function choosePreset(p: ProviderPreset) {
    setKey('');
    setResult(null);
    setAdvanced(false);
    setDraft({
      id: crypto.randomUUID(),
      name: t(`aiPresets.${p.id}.name`),
      type: p.adapter,
      mode: 'apiKey',
      presetId: p.id,
      endpoint: p.endpoint,
      model: '',
      models: [],
      proxy: 'system',
      proxyUrl: '',
      connectionStatus: 'untested',
    });
  }
  async function testConnection(p = draft) {
    if (!p) return;
    setBusy(true);
    setResult(null);
    setError('');
    try {
      const value = await window.brickloop.aiTestProviderDraft(p, key || undefined);
      setResult(value);
      if (!value.error) {
        const next = {
          ...p,
          model: value.model,
          models: value.models.map((m) => m.id),
          connectionStatus: 'available' as const,
        };
        delete next.modelsError;
        setDraft(next);
      }
      if (value.needsModel) setAdvanced(true);
    } catch {
      setError('aiUi.connectionFailed');
    } finally {
      setBusy(false);
    }
  }
  async function signIn() {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const signed = await window.brickloop.aiSignInDraft();
      updateSnapshot(signed.snapshot);
      setDraft(signed.provider);
      setResult(signed.result);
    } catch (failure) {
      setError(String(failure).includes('LOGIN_TIMEOUT') ? 'aiUi.loginTimeout' : 'aiUi.failed');
    } finally {
      setBusy(false);
    }
  }
  async function save(untested = false) {
    if (!draft || missingReplacementKey) return;
    setBusy(true);
    setError('');
    try {
      updateSnapshot(
        await window.brickloop.aiSaveProvider(
          { ...draft, connectionStatus: untested ? 'untested' : 'available' },
          key || undefined,
        ),
      );
      setKey('');
      close();
    } catch {
      setError('aiUi.invalidProvider');
    } finally {
      setBusy(false);
      setConfirmed(false);
    }
  }
  const canTest =
    !!draft &&
    !missingReplacementKey &&
    (!preset?.requiresKey || !!key.trim() || !!state.snapshot?.masks[draft.id]) &&
    (draft.type !== 'chatgpt' || signedIn.some((a) => a.id === draft.accountId));
  const capabilities = draft ? presetCapabilities(draft.presetId, draft.model) : null;
  const addressFields = draft && (
    <>
      <label className="ai-form-field">
        <span>{t('aiUi.endpoint')}</span>
        {preset?.overseasEndpoint && (
          <div className="ai-region-switch">
            {(['domestic', 'overseas'] as const).map((region) => (
              <Button
                key={region}
                size="small"
                disabled={disabled}
                onClick={() => change({ endpoint: region === 'domestic' ? preset.endpoint : preset.overseasEndpoint! })}
              >
                {t(`aiSetup.${region}`)}
              </Button>
            ))}
          </div>
        )}
        <Input
          aria-label={t('aiUi.endpoint')}
          value={draft.endpoint}
          disabled={disabled || draft.type === 'chatgpt'}
          onChange={(e) => change({ endpoint: e.target.value })}
        />
      </label>
      <label className="ai-form-field">
        <span>{t('aiUi.type')}</span>
        <Select
          aria-label={t('aiUi.type')}
          value={draft.type}
          disabled={disabled || preset?.id !== 'custom'}
          options={[
            'compatible',
            'openai',
            'anthropic',
            'gemini',
            ...(draft.type === 'chatgpt' ? ['chatgpt'] : []),
          ].map((value) => ({ value, label: t(`aiUi.types.${value}`) }))}
          onChange={(type: AiProvider['type']) => change({ type, models: [], model: '' })}
        />
      </label>
    </>
  );
  return (
    <Modal
      title={t(mode === 'choose' ? 'aiSetup.chooseMode' : 'aiUi.providerDialog')}
      open
      width={680}
      className="ai-provider-modal"
      maskClosable={false}
      closable={!busy}
      onCancel={() => {
        if (!busy) {
          setKey('');
          close();
        }
      }}
      footer={
        <div className="ai-setup-footer">
          <Button
            disabled={busy}
            onClick={() => {
              setKey('');
              close();
            }}
          >
            {t('aiUi.cancel')}
          </Button>
          {draft && (
            <>
              <Button disabled={disabled || missingReplacementKey} onClick={() => setConfirmed(true)}>
                {t('aiSetup.saveUntested')}
              </Button>
              <Button
                aria-label={t('aiUi.save')}
                type="primary"
                loading={busy}
                disabled={disabled || !success || missingReplacementKey}
                onClick={() => void save()}
              >
                {t('aiUi.save')}
              </Button>
            </>
          )}
        </div>
      }
    >
      <div className="ai-provider-form">
        <p className="secondary">{t(mode === 'choose' ? 'aiSetup.stepOne' : 'aiSetup.stepTwo')}</p>
        {mode !== 'choose' && (
          <Button
            className="ai-setup-back"
            type="text"
            icon={<ArrowLeft />}
            disabled={busy}
            onClick={() =>
              draft && mode === 'apiKey' && !initialProvider ? chooseMode('apiKey') : chooseMode('choose')
            }
          >
            {t('aiSetup.back')}
          </Button>
        )}
        {error && <Alert type="error" title={t(error)} />}
        {mode === 'choose' && <ModeChoices choose={chooseMode} />}
        {mode === 'apiKey' && !draft && (
          <>
            <Input.Search
              aria-label={t('aiSetup.search')}
              placeholder={t('aiSetup.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="ai-preset-grid">
              {providerPresets
                .filter((p) =>
                  `${Object.values(p.name).join(' ')} ${Object.values(p.description).join(' ')}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .map((p) => (
                  <Button className="ai-preset" key={p.id} onClick={() => choosePreset(p)}>
                    <strong>{t(`aiPresets.${p.id}.name`)}</strong>
                    <span>{t(`aiPresets.${p.id}.description`)}</span>
                    {!p.capabilities.some((r) => r.vision) && <small>{t('aiSetup.noVisionModels')}</small>}
                    {!p.capabilities.some((r) => r.tools) && <small>{t('aiSetup.noToolModels')}</small>}
                  </Button>
                ))}
            </div>
          </>
        )}
        {mode === 'account' && (
          <div className="ai-account-setup">
            <h3>{t('aiUi.chatgpt')}</h3>
            <p>{t('aiSetup.modeHints.account')}</p>
            <Button
              className="chatgpt-signin"
              disabled={disabled || !settings.chatgptEnabled || settings.localOnly}
              onClick={() => void signIn()}
            >
              <img src={chatgptLogo} alt="" width={20} height={20} />
              {t('aiUi.chatgptContinue')}
            </Button>
            {!settings.chatgptEnabled && <p>{t('aiSetup.accountDisabled')}</p>}
            {settings.localOnly && <p>{t('aiSetup.localOnlyAccount')}</p>}
            {signedIn.length > 0 && (
              <label className="ai-form-field">
                <span>{t('aiUi.account')}</span>
                <Select
                  aria-label={t('aiUi.account')}
                  value={draft?.accountId ?? null}
                  disabled={disabled}
                  options={signedIn.map((a) => ({ value: a.id, label: a.email ?? a.subject }))}
                  onChange={(accountId: string) => {
                    const p = settings.providers.find((p) => p.type === 'chatgpt' && p.accountId === accountId) ?? {
                      id: crypto.randomUUID(),
                      type: 'chatgpt' as const,
                      mode: 'account' as const,
                      presetId: 'chatgpt',
                      name: 'ChatGPT',
                      endpoint: 'https://api.openai.com/v1',
                      accountId,
                      model: '',
                      models: [],
                      proxy: 'system' as const,
                      proxyUrl: '',
                    };
                    setDraft(p);
                    setResult(null);
                  }}
                />
              </label>
            )}
            <Alert type="info" title={t('aiSetup.unsupportedSubscriptions')} description={t('aiSetup.kimiReason')} />
            <Button onClick={() => chooseMode('apiKey')} disabled={busy}>
              {t('aiSetup.useApiKeyInstead')}
            </Button>
            <p className="secondary">{t('aiUi.quotaPolicy')}</p>
          </div>
        )}
        {draft && (
          <>
            {mode === 'apiKey' && <h3>{preset ? t(`aiPresets.${preset.id}.name`) : draft.name}</h3>}
            {mode === 'apiKey' && (preset?.requiresKey || preset?.id === 'custom' || unreadableKey) && (
              <>
                <label className="ai-form-field">
                  <span>{t('aiUi.key')}</span>
                  <Input.Password
                    aria-label={t('aiUi.key')}
                    autoComplete="off"
                    value={key}
                    disabled={disabled}
                    required={unreadableKey}
                    placeholder={
                      unreadableKey
                        ? t('aiSetup.reenterKey')
                        : state.snapshot?.masks[draft.id]
                          ? t('aiSetup.keepKey')
                          : t('aiUi.keyHint')
                    }
                    onChange={(e) => {
                      setKey(e.target.value);
                      setResult(null);
                    }}
                  />
                </label>
                {preset?.keyUrl && (
                  <Button
                    type="link"
                    className="ai-key-link"
                    onClick={() =>
                      void window.brickloop.aiOpenPresetLink(preset.id, 'key').catch(() => setError('aiUi.failed'))
                    }
                  >
                    {t('aiSetup.getKey')}
                  </Button>
                )}
              </>
            )}
            {preset && <p className="secondary">{t(`aiPresets.${preset.id}.keyHint`)}</p>}
            {preset?.id === 'custom' && addressFields}
            <Button
              aria-label={t('aiUi.testConnection')}
              icon={<Plug />}
              loading={busy}
              disabled={disabled || !canTest}
              onClick={() => void testConnection()}
            >
              {t('aiUi.testConnection')}
            </Button>
            {result && (result.elapsedMs > 0 || result.error) && <ConnectionFeedback result={result} />}
            {(success || !!result?.models.length) && (
              <>
                <label className="ai-form-field">
                  <span>{t('aiUi.model')}</span>
                  <Select
                    aria-label={t('aiUi.model')}
                    showSearch={{ optionFilterProp: 'label' }}
                    value={draft.model || null}
                    disabled={disabled}
                    options={result?.models.map((m) => ({ value: m.id, label: m.name })) ?? []}
                    onChange={(model: string) => setDraft({ ...draft, model })}
                  />
                </label>
                {capabilities && (
                  <div className="ai-model-capabilities">
                    <Tag>
                      {t(
                        !capabilities.known
                          ? 'aiSetup.unknownCapabilities'
                          : capabilities.vision
                            ? 'aiSetup.canSee'
                            : 'aiSetup.cannotSee',
                      )}
                    </Tag>
                    <Tag>
                      {t(
                        !capabilities.known
                          ? 'aiSetup.checkTools'
                          : capabilities.tools
                            ? 'aiSetup.canUseTools'
                            : 'aiSetup.cannotUseTools',
                      )}
                    </Tag>
                    {capabilities.known && (!capabilities.tools || !capabilities.vision) && (
                      <p className="secondary">{t('aiSetup.capabilityHint')}</p>
                    )}
                  </div>
                )}
              </>
            )}
            <details
              className="ai-provider-advanced"
              open={advanced}
              onToggle={(e) => setAdvanced(e.currentTarget.open)}
            >
              <summary>{t('aiSetup.advanced')}</summary>
              <div className="ai-provider-form">
                <label className="ai-form-field">
                  <span>{t('aiUi.name')}</span>
                  <Input
                    aria-label={t('aiUi.name')}
                    disabled={disabled}
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </label>
                {preset?.id !== 'custom' && addressFields}
                <label className="ai-form-field">
                  <span>{t('aiUi.proxy')}</span>
                  <Select
                    aria-label={t('aiUi.proxy')}
                    value={draft.proxy}
                    disabled={disabled}
                    options={['system', 'custom'].map((value) => ({ value, label: t(`aiUi.proxyOptions.${value}`) }))}
                    onChange={(proxy: AiProvider['proxy']) => change({ proxy })}
                  />
                </label>
                {draft.proxy === 'custom' && (
                  <Input
                    aria-label={t('aiUi.proxyAddress')}
                    disabled={disabled}
                    value={draft.proxyUrl}
                    onChange={(e) => change({ proxyUrl: e.target.value })}
                  />
                )}
                <label className="ai-form-field">
                  <span>{t('aiUi.customModelName')}</span>
                  <Input
                    aria-label={t('aiUi.customModelName')}
                    disabled={disabled}
                    value={draft.model}
                    onChange={(e) => change({ model: e.target.value })}
                  />
                </label>
                {draft.type !== 'chatgpt' && (
                  <>
                    <Checkbox
                      checked={!!draft.prices}
                      disabled={disabled}
                      onChange={(e) => {
                        const next = { ...draft };
                        if (e.target.checked) next.prices = { input: 0, output: 0, cacheRead: 0 };
                        else delete next.prices;
                        setDraft(next);
                        setResult(null);
                      }}
                    >
                      {t('aiUi.customPrices')}
                    </Checkbox>
                    {draft.prices && (
                      <div className="ai-limits">
                        {(['input', 'output', 'cacheRead'] as const).map((field) => (
                          <label key={field}>
                            {t(`aiUi.prices.${field}`)}
                            <InputNumber
                              aria-label={t(`aiUi.prices.${field}`)}
                              disabled={disabled}
                              min={0}
                              value={draft.prices![field]}
                              onChange={(value) => change({ prices: { ...draft.prices!, [field]: value ?? 0 } })}
                            />
                          </label>
                        ))}
                      </div>
                    )}
                  </>
                )}
                {preset && (
                  <Button
                    type="link"
                    onClick={() =>
                      void window.brickloop.aiOpenPresetLink(preset.id, 'docs').catch(() => setError('aiUi.failed'))
                    }
                  >
                    {t('aiSetup.documentation')}
                  </Button>
                )}
              </div>
            </details>
          </>
        )}
      </div>
      <Modal
        open={confirmed}
        title={t('aiSetup.confirmUntested')}
        onCancel={() => setConfirmed(false)}
        onOk={() => void save(true)}
        okText={t('aiSetup.saveUntested')}
        cancelText={t('aiUi.cancel')}
        confirmLoading={busy}
      >
        <p>{t('aiSetup.confirmUntestedHint')}</p>
      </Modal>
    </Modal>
  );
}
