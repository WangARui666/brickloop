import { useTaskStore } from './ai-task-runtime';
import { useState } from 'react';
import { Alert, Button, Checkbox, Input, InputNumber, Modal, Select, Tabs } from 'antd';
import { Bot, Copy } from 'lucide-react';
import type { AiSettings as Settings, AiSnapshot } from '../../shared/ai-api';
import { useAiStore } from './ai-store';
import { useShellStore, useTranslation } from './store';
import { AiServices } from './AiServices';
import { formatUsd } from './ai-format';
import { SettingsDialog } from './SettingsDialog';
import { useSettingsPages } from './SettingsPages';
import { usePreferences } from './preferences-store';

export function AiSettings() {
  const pages = useSettingsPages(),
    page = usePreferences((s) => s.page);
  const state = useAiStore(),
    t = useTranslation();
  const [providerDialogOpen, setProviderDialogOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [token, setToken] = useState('');
  const settings = state.snapshot?.settings;
  async function run(action: () => Promise<AiSnapshot>) {
    setBusy(true);
    setError(null);
    try {
      useAiStore.setState({ snapshot: await action() });
    } catch (failure) {
      // IPC errors carry the main-process error code in their message.
      setError(String(failure).includes('LOGIN_TIMEOUT') ? 'aiUi.loginTimeout' : 'aiUi.failed');
    } finally {
      setBusy(false);
    }
  }
  function save(patch: Partial<Settings>) {
    if (settings) void run(() => window.brickloop.aiSaveSettings({ ...settings, ...patch }));
  }
  const disabled = busy || state.running;
  const defaultProvider =
    settings?.providers.find((p) => p.id === settings.defaultProviderId) ?? settings?.providers[0];
  const modelOptions =
    settings?.providers.flatMap((p) =>
      [...new Set([p.model, ...p.models])]
        .filter(Boolean)
        .map((model) => ({ value: `${p.id}/${model}`, label: `${p.name} · ${model}` })),
    ) ?? [];
  const shim = state.snapshot?.shim.replaceAll('\\', '/') ?? '';
  const packaged = shim.endsWith('.cmd');
  // MCP clients spawn a process directly. Avoid cmd.exe's second round of path quoting.
  const command = packaged ? shim.replace(/brickloop-mcp\.cmd$/, 'Brickloop.exe') : 'node';
  const args = packaged ? [shim.replace(/brickloop-mcp\.cmd$/, 'resources/app.asar/out/main/mcp-shim.js')] : [shim];
  const env = packaged ? { ELECTRON_RUN_AS_NODE: '1' } : undefined;
  const codex = `[mcp_servers.brickloop]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}${packaged ? '\nenv = { ELECTRON_RUN_AS_NODE = "1" }' : ''}\nstartup_timeout_sec = 20\ntool_timeout_sec = 90\n# ${t('aiUi.codexApprovalHint')}\n# default_tools_approval_mode = "approve"`;
  const claude = JSON.stringify(
    { mcpServers: { brickloop: { type: 'stdio', command, args, ...(env ? { env } : {}) } } },
    null,
    2,
  );
  return (
    <>
      <Modal
        open={
          !!settings &&
          !providerDialogOpen &&
          !settings.chatgptWelcomeSeen &&
          !settings.providers.some(
            (p) => p.type === 'chatgpt' && p.accountId === state.snapshot?.activeAccountId && p.modelsError,
          ) &&
          !!state.snapshot?.accounts.some((a) => a.signedIn && a.planEnabled)
        }
        title={t('aiUi.planWelcome')}
        width={480}
        closable={false}
        footer={<Button onClick={() => save({ chatgptWelcomeSeen: true })}>{t('aiUi.gotIt')}</Button>}
      >
        <p>{t('aiUi.planWelcomeHint')}</p>
        <Button type="text" onClick={() => void window.brickloop.aiManageUsage()}>
          {t('aiUi.manageUsage')}
        </Button>
      </Modal>
      <SettingsDialog open={state.settingsOpen} onClose={() => useAiStore.setState({ settingsOpen: false })}>
        {error && <Alert type="error" title={t(error)} closable onClose={() => setError(null)} />}
        {settings && (
          <Tabs
            className="settings-tabs"
            tabPlacement="start"
            activeKey={page}
            onChange={(page) => usePreferences.setState({ page })}
            items={[
              ...pages.slice(0, 4),
              {
                key: 'ai',
                label: t('aiUi.title'),
                children: (
                  <div className="ai-settings-page">
                    <AiServices onOpenChange={setProviderDialogOpen} />
                    <div className="ai-purpose-grid">
                      <h3>{t('aiUi.choosePurpose')}</h3>
                      {(['chat', 'vision', 'quick'] as const).map((purpose) => (
                        <label key={purpose}>
                          <span>{t(`aiUi.purpose.${purpose}`)}</span>
                          <Select
                            aria-label={t(`aiUi.purpose.${purpose}`)}
                            value={settings.defaults[purpose] || undefined}
                            placeholder={t('aiUi.followDefault', {
                              provider: defaultProvider?.name ?? t('aiUi.noProviders'),
                              model: defaultProvider?.model ?? t('aiUi.noModel'),
                            })}
                            allowClear
                            options={modelOptions}
                            disabled={disabled}
                            onChange={(value: string | undefined) =>
                              save({ defaults: { ...settings.defaults, [purpose]: value ?? '' } })
                            }
                          />
                        </label>
                      ))}
                    </div>

                    <div className="ai-section-title">
                      <h3>{t('aiUi.budgets')}</h3>
                      <small>{t('aiUi.spent', { amount: formatUsd(state.snapshot?.spent ?? 0) })}</small>
                    </div>
                    <div className="ai-limits">
                      <label>
                        {t('aiUi.dailyLimit')}
                        <InputNumber
                          aria-label={t('aiUi.dailyLimit')}
                          min={0}
                          placeholder={t('aiUi.unlimited')}
                          value={settings.dailyLimit}
                          disabled={disabled}
                          onChange={(value) => save({ dailyLimit: value })}
                        />
                      </label>
                    </div>
                    <div className="ai-privacy">
                      {(['history', 'localOnly', 'debug'] as const).map((key) => (
                        <Checkbox
                          key={key}
                          checked={settings[key]}
                          disabled={disabled}
                          onChange={(e) => save({ [key]: e.target.checked })}
                        >
                          {t(`aiUi.${key}`)}
                        </Checkbox>
                      ))}
                    </div>
                    <details className="ai-page-advanced">
                      <summary>{t('aiUi.advanced')}</summary>
                      <Checkbox
                        checked={settings.chatgptEnabled}
                        disabled={disabled}
                        onChange={(e) => save({ chatgptEnabled: e.target.checked })}
                      >
                        {t('aiSetup.enableAccount')}
                      </Checkbox>
                      <div className="ai-limits">
                        <label>
                          {t('parallelUi.concurrency')}
                          <InputNumber
                            min={1}
                            max={5}
                            value={settings.concurrency}
                            aria-label={t('parallelUi.concurrency')}
                            disabled={busy}
                            onChange={(value) => {
                              if (value) save({ concurrency: value });
                            }}
                          />
                        </label>
                        <label>
                          {t('aiUi.toolLimit')}
                          <InputNumber
                            aria-label={t('aiUi.toolLimit')}
                            min={1}
                            max={1000}
                            placeholder={t('aiUi.unlimited')}
                            value={settings.toolLimit}
                            disabled={disabled}
                            onChange={(value) => {
                              save({ toolLimit: value });
                            }}
                          />
                        </label>
                        <label>
                          {t('aiUi.duration')}
                          <InputNumber
                            aria-label={t('aiUi.duration')}
                            min={1}
                            max={120}
                            placeholder={t('aiUi.unlimited')}
                            value={settings.durationMinutes}
                            disabled={disabled}
                            onChange={(value) => {
                              save({ durationMinutes: value });
                            }}
                          />
                        </label>
                      </div>
                    </details>
                  </div>
                ),
              },
              {
                key: 'mcp',
                label: t('aiUi.external'),
                children: (
                  <div className="ai-settings-page">
                    <Checkbox
                      checked={settings.mcpEnabled}
                      disabled={disabled}
                      onChange={(e) => save({ mcpEnabled: e.target.checked })}
                    >
                      {t('aiUi.mcpEnabled')}
                    </Checkbox>
                    <p className="secondary">{t('aiUi.mcpHint')}</p>
                    <Checkbox
                      checked={settings.httpEnabled}
                      disabled={disabled || !settings.mcpEnabled}
                      onChange={(e) => save({ httpEnabled: e.target.checked })}
                    >
                      {t('aiUi.httpEnabled')}
                    </Checkbox>
                    <label className="ai-form-field">
                      <span>{t('aiUi.port')}</span>
                      <InputNumber
                        min={1024}
                        max={65535}
                        value={settings.httpPort}
                        disabled={disabled || settings.httpEnabled}
                        onChange={(value) => {
                          if (value) save({ httpPort: value });
                        }}
                      />
                    </label>
                    <Button
                      disabled={disabled}
                      onClick={() => {
                        void window.brickloop
                          .aiGenerateToken()
                          .then(setToken)
                          .catch(() => setError('aiUi.failed'));
                      }}
                    >
                      {t('aiUi.generateToken')}
                    </Button>
                    {token && (
                      <div className="ai-token">
                        <Input.Password readOnly value={token} aria-label={t('aiUi.token')} />
                        <Button
                          icon={<Copy />}
                          aria-label={t('aiUi.copyToken')}
                          onClick={() => void window.brickloop.copyText(token)}
                        />
                      </div>
                    )}
                    {state.snapshot?.httpUrl && <p>{state.snapshot.httpUrl}</p>}
                    <h3>{t('aiUi.configuration')}</h3>
                    <Tabs
                      items={[
                        { key: 'codex', label: 'Codex', children: <pre className="ai-config">{codex}</pre> },
                        { key: 'claude', label: 'Claude Code', children: <pre className="ai-config">{claude}</pre> },
                      ]}
                    />
                    <p className="secondary">{t('aiUi.configHint')}</p>
                  </div>
                ),
              },
              ...pages.slice(4),
            ]}
          />
        )}
      </SettingsDialog>
      <Modal
        open={!!state.approval}
        title={
          state.approval?.kind === 'mcp'
            ? t('aiUi.allowClient', { name: state.approval.name })
            : t('aiUi.imageConsentTitle')
        }
        width={480}
        className="ai-approval-modal"
        okText={t('aiUi.allow')}
        cancelText={t('aiUi.deny')}
        onOk={() => {
          if (state.approval) void window.brickloop.aiApprove(state.approval.id, true);
        }}
        onCancel={() => {
          if (state.approval) void window.brickloop.aiApprove(state.approval.id, false);
        }}
      >
        <div className="ai-approval">
          <Bot />
          <div>
            <p>
              {state.approval?.kind === 'mcp'
                ? t('aiUi.allowClientHint')
                : t('aiUi.imageConsentHint', { name: state.approval?.name })}
            </p>
            <p className="secondary">
              {state.approval?.kind === 'mcp'
                ? t('aiUi.clientVersion', { version: state.approval.detail })
                : state.approval?.detail}
            </p>
          </div>
        </div>
      </Modal>
    </>
  );
}
export function AiStatus() {
  const t = useTranslation(),
    state = useAiStore(),
    tasks = useTaskStore((s) => s.tasks);
  const running = Object.values(tasks).filter((v) => v.status === 'running').length,
    pending = Object.values(tasks).filter((v) => v.status === 'pending_merge').length;
  return (
    <>
      {(running > 0 || pending > 0) && (
        <Button
          className="ai-task-status"
          size="small"
          type="text"
          onClick={() => useShellStore.setState({ rightCollapsed: false, rightTab: 'ai' })}
        >
          {t('parallelUi.globalStatus', { running, pending })}
        </Button>
      )}
      {!!state.snapshot?.connections && (
        <span className="ai-status" data-testid="external-agent-status">
          <Bot size={16} />
          {t('aiUi.connectedAgents', { count: state.snapshot.connections })}
          <Button size="small" type="text" onClick={() => void window.brickloop.aiDisconnect()}>
            {t('aiUi.disconnect')}
          </Button>
        </span>
      )}
    </>
  );
}
