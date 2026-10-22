import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { z } from 'zod';
import type { SecretStore } from '../secrets.js';
import { CredentialError, isSecretReadError } from '../secrets.js';
import { OpenAIResponsesProvider } from '../providers/openai-responses.js';

const stateKey = 'ai:chatgpt:state';
const resource = 'https://api.openai.com/v1';
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const terminalRefresh = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().optional(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
  earliest_refresh_at: z.union([z.number(), z.string()]).optional(),
  client_id: z.string().optional(),
});
const discoverySchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
  revocation_endpoint: z.url().optional(),
});
export interface ChatGptAccount {
  id: string;
  issuer: string;
  subject: string;
  clientId: string;
  email?: string;
  label: string;
  planEnabled: boolean;
  signedIn: boolean;
}
interface Credentials {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  nonce: string;
  expiresAt: number;
  earliestRefreshAt: number;
  scopes: string[];
}
interface AccountRecord extends ChatGptAccount {
  credentials?: Credentials;
}
interface AuthState {
  hostId: string;
  accounts: AccountRecord[];
  activeId?: string;
}
export interface ChatGptAuthOptions {
  store: SecretStore;
  openExternal(url: string): Promise<void>;
  enabled?: boolean;
  fetch?: typeof fetch;
  /** Override only for isolated local OAuth tests / a trusted identity deployment. */
  issuer?: string;
  apiBaseURL?: string;
  now?: () => number;
  loginTimeoutMs?: number;
  refreshSkewMs?: number;
}
export class ChatGptAuthError extends CredentialError {
  constructor(
    code: string,
    readonly clientId?: string,
  ) {
    super(code);
    this.name = 'ChatGptAuthError';
  }
}
// A rotating refresh token must have a single owner. The host shares one SecretStore
// instance per main process; cross-process ownership remains the host's responsibility.
const queues = new WeakMap<SecretStore, Promise<unknown>>();
function exclusive<T>(store: SecretStore, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(store) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  queues.set(
    store,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}
function publicAccount(record: AccountRecord): ChatGptAccount {
  const { credentials: _credentials, ...account } = record;
  void _credentials;
  return account;
}
function same(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export class ChatGptAuth {
  private readonly hostId = `urn:uuid:${randomUUID()}`;
  private enabled: boolean;
  private readonly fetcher: typeof fetch;
  private readonly issuer: string;
  private readonly now: () => number;
  private discovery?: z.output<typeof discoverySchema>;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  private sessions = new Map<string, AbortController>();
  private loginController: AbortController | undefined;
  constructor(private readonly options: ChatGptAuthOptions) {
    this.enabled = options.enabled ?? true;
    this.fetcher = options.fetch ?? fetch;
    this.issuer = options.issuer ?? 'https://auth.openai.com';
    this.now = options.now ?? Date.now;
    this.checkEndpoint(this.issuer);
  }
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.loginController?.abort();
      for (const c of this.sessions.values()) c.abort();
      this.sessions.clear();
    }
  }
  isEnabled(): boolean {
    return this.enabled;
  }
  private requireEnabled() {
    if (!this.enabled) throw new ChatGptAuthError('FEATURE_DISABLED');
  }
  private checkEndpoint(value: string) {
    const url = new URL(value);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))
      throw new ChatGptAuthError('INSECURE_ENDPOINT');
  }
  private async load(): Promise<AuthState> {
    const raw = await this.options.store.get(stateKey);
    if (raw) return JSON.parse(raw) as AuthState;
    return { hostId: this.hostId, accounts: [] };
  }
  private save(state: AuthState): Promise<void> {
    return this.options.store.set(stateKey, JSON.stringify(state));
  }
  private async configuration() {
    if (!this.discovery) {
      const response = await this.fetcher(`${this.issuer}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
      if (!response.ok) throw new ChatGptAuthError('DISCOVERY_FAILED');
      const d = discoverySchema.parse(await response.json());
      if (d.issuer !== this.issuer) throw new ChatGptAuthError('ISSUER_MISMATCH');
      for (const endpoint of [d.authorization_endpoint, d.token_endpoint, d.jwks_uri, d.revocation_endpoint].filter(
        (v): v is string => Boolean(v),
      )) {
        this.checkEndpoint(endpoint);
        if (new URL(endpoint).origin !== new URL(this.issuer).origin)
          throw new ChatGptAuthError('ENDPOINT_ORIGIN_MISMATCH');
      }
      this.discovery = d;
      this.jwks = createRemoteJWKSet(new URL(d.jwks_uri), { [customFetch]: this.fetcher });
    }
    return this.discovery;
  }
  async accounts(): Promise<{ accounts: ChatGptAccount[]; activeId?: string; unreadable?: boolean }> {
    return exclusive(this.options.store, async () => {
      try {
        const s = await this.load();
        return { accounts: s.accounts.map(publicAccount), ...(s.activeId ? { activeId: s.activeId } : {}) };
      } catch (error) {
        if (!isSecretReadError(error)) throw error;
        return { accounts: [], unreadable: true };
      }
    });
  }
  async selectAccount(id: string): Promise<void> {
    this.requireEnabled();
    await exclusive(this.options.store, async () => {
      const s = await this.load();
      const account = s.accounts.find((a) => a.id === id);
      if (!account?.credentials) throw new ChatGptAuthError('SIGN_IN_REQUIRED');
      if (s.activeId && s.activeId !== id) this.stopSession(s.activeId);
      s.activeId = id;
      await this.save(s);
    });
  }
  private async exchange(params: URLSearchParams, signal?: AbortSignal) {
    const d = await this.configuration();
    const response = await this.fetcher(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: signal ?? AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      const known = new Set([
        ...terminalRefresh,
        'invalid_client',
        'invalid_request',
        'invalid_scope',
        'unauthorized_client',
        'unsupported_grant_type',
        'server_error',
        'temporarily_unavailable',
      ]);
      throw new ChatGptAuthError(
        parsed.success && known.has(parsed.data.error) ? parsed.data.error : 'TOKEN_EXCHANGE_FAILED',
        params.get('client_id') ?? undefined,
      );
    }
    return tokenSchema.parse(body);
  }
  private async identity(token: string, clientId: string, nonce?: string) {
    await this.configuration();
    if (!this.jwks) throw new ChatGptAuthError('JWKS_UNAVAILABLE');
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: clientId,
        requiredClaims: ['sub', 'exp', 'iat'],
        algorithms: ['RS256', 'ES256'],
        clockTolerance: 5,
        currentDate: new Date(this.now()),
      });
      if (
        !payload.sub ||
        (nonce !== undefined && payload.nonce !== nonce) ||
        (payload.azp !== undefined && payload.azp !== clientId) ||
        (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)
      )
        throw new ChatGptAuthError('INVALID_ID_TOKEN');
      return payload;
    } catch {
      throw new ChatGptAuthError('INVALID_ID_TOKEN');
    }
  }
  private credentials(tokens: z.output<typeof tokenSchema>, nonce: string, previous?: Credentials): Credentials {
    const earliest =
      typeof tokens.earliest_refresh_at === 'number'
        ? tokens.earliest_refresh_at * 1000
        : tokens.earliest_refresh_at
          ? Date.parse(tokens.earliest_refresh_at)
          : 0;
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token ?? previous?.idToken ?? '',
      nonce,
      expiresAt: this.now() + tokens.expires_in * 1000,
      earliestRefreshAt: Number.isFinite(earliest) ? earliest : 0,
      scopes: tokens.scope !== undefined ? tokens.scope.split(/\s+/).filter(Boolean) : (previous?.scopes ?? []),
    };
  }
  async signIn(
    options: {
      accountId?: string;
      registrationClientId?: string;
      signal?: AbortSignal;
      requestPlanConsent?: boolean;
    } = {},
  ): Promise<ChatGptAccount> {
    this.requireEnabled();
    return exclusive(this.options.store, async () => {
      this.requireEnabled();
      // Only an explicit, successful sign-in may replace an unreadable saved state.
      const state = await this.load().catch((error: unknown): AuthState => {
        if (!isSecretReadError(error)) throw error;
        return { hostId: this.hostId, accounts: [] };
      });
      const previous = options.accountId ? state.accounts.find((a) => a.id === options.accountId) : undefined;
      if (options.accountId && !previous) throw new ChatGptAuthError('ACCOUNT_NOT_FOUND');
      const d = await this.configuration();
      this.requireEnabled();
      const pendingClientId = previous?.clientId ?? options.registrationClientId;
      if (pendingClientId === 'dynamic_agent_client') throw new ChatGptAuthError('REGISTRATION_INCOMPLETE');
      const controller = new AbortController();
      this.loginController = controller;
      const timeout = AbortSignal.timeout(this.options.loginTimeoutMs ?? 300_000);
      const signal = AbortSignal.any([controller.signal, timeout, ...(options.signal ? [options.signal] : [])]);
      const attemptState = randomBytes(32).toString('base64url'),
        nonce = randomBytes(32).toString('base64url'),
        verifier = randomBytes(64).toString('base64url');
      let settle: (url: URL) => void = () => undefined;
      let reject: (error: Error) => void = () => undefined;
      const callback = new Promise<URL>((resolve, fail) => {
        settle = resolve;
        reject = fail;
      });
      // Install a handler before openExternal, which may itself wait for the callback in tests.
      void callback.catch(() => undefined);
      let consumed = false;
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (request.method !== 'GET' || url.pathname !== '/auth/callback') {
          response.writeHead(404).end();
          return;
        }
        response.setHeader('Cache-Control', 'no-store');
        if (consumed) {
          response.writeHead(409).end('Already received.');
          return;
        }
        consumed = true;
        const valid = same(url.searchParams.get('state') ?? '', attemptState);
        response
          .writeHead(valid ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' })
          .end(valid ? 'You may return to Brickloop.' : 'Invalid authorization state.');
        if (!valid) reject(new ChatGptAuthError('STATE_MISMATCH'));
        else settle(url);
      });
      // A browser that never calls back is a timeout, not a user cancellation.
      const abort = () => reject(new ChatGptAuthError(timeout.aborted ? 'LOGIN_TIMEOUT' : 'LOGIN_CANCELLED'));
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        await new Promise<void>((resolve, fail) => {
          server.once('error', fail);
          server.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address();
        if (!address || typeof address === 'string') throw new ChatGptAuthError('CALLBACK_FAILED');
        const redirect = `http://127.0.0.1:${address.port}/auth/callback`;
        const url = new URL(d.authorization_endpoint);
        const params: Record<string, string> = {
          client_id: pendingClientId ?? 'dynamic_agent_client',
          ext_agent_host_id: state.hostId,
          response_type: 'code',
          redirect_uri: redirect,
          scope: scopes,
          resource,
          state: attemptState,
          nonce,
          code_challenge_method: 'S256',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        };
        if (!pendingClientId) params.agent_name_hint = 'Brickloop';
        if (previous?.credentials?.idToken) params.id_token_hint = previous.credentials.idToken;
        if (previous?.email) params.login_hint = previous.email;
        if (options.requestPlanConsent) params.prompt = 'consent';
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        await this.options.openExternal(url.toString());
        const returned = (await callback).searchParams;
        if (returned.has('error'))
          throw new ChatGptAuthError(
            returned.get('error') === 'access_denied' ? 'ACCESS_DENIED' : 'AUTHORIZATION_FAILED',
          );
        const clientId = returned.get('client_id') ?? pendingClientId;
        if (!clientId || clientId === 'dynamic_agent_client') throw new ChatGptAuthError('REGISTRATION_INCOMPLETE');
        if (pendingClientId && clientId !== pendingClientId) throw new ChatGptAuthError('CLIENT_ID_MISMATCH');
        const code = returned.get('code');
        if (!code) throw new ChatGptAuthError('CODE_MISSING');
        const tokens = await this.exchange(
          new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            code,
            code_verifier: verifier,
            redirect_uri: redirect,
            resource,
          }),
          signal,
        );
        if (!tokens.id_token || (tokens.client_id && tokens.client_id !== clientId))
          throw new ChatGptAuthError('CLIENT_ID_MISMATCH');
        const identity = await this.identity(tokens.id_token, clientId, nonce);
        if (previous && previous.subject !== identity.sub) throw new ChatGptAuthError('ACCOUNT_MISMATCH');
        signal.throwIfAborted();
        this.requireEnabled();
        const credentials = this.credentials(tokens, nonce);
        const existing =
          state.accounts.find((a) => a.clientId === clientId) ??
          state.accounts.find((a) => a.issuer === this.issuer && a.subject === identity.sub);
        if (existing && existing.subject !== identity.sub) throw new ChatGptAuthError('ACCOUNT_MISMATCH');
        const account: AccountRecord = {
          id: previous?.id ?? existing?.id ?? randomUUID(),
          issuer: this.issuer,
          subject: identity.sub!,
          clientId,
          ...(typeof identity.email === 'string' ? { email: identity.email } : {}),
          label: `${typeof identity.email === 'string' ? identity.email : identity.sub} · ${clientId}`,
          planEnabled:
            credentials.scopes.includes('chatgpt.tokens.use.direct') && credentials.scopes.includes('resource.invoke'),
          signedIn: true,
          credentials,
        };
        state.accounts = [...state.accounts.filter((a) => a.id !== account.id), account];
        if (state.activeId) this.stopSession(state.activeId);
        state.activeId = account.id;
        await this.save(state);
        return publicAccount(account);
      } catch (error) {
        if (error instanceof ChatGptAuthError) throw error;
        throw new ChatGptAuthError(signal.aborted ? 'LOGIN_CANCELLED' : 'LOGIN_FAILED');
      } finally {
        signal.removeEventListener('abort', abort);
        this.loginController = undefined;
        server.closeAllConnections();
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }
  async getAccessToken(accountId?: string): Promise<string> {
    this.requireEnabled();
    return exclusive(this.options.store, async () => {
      this.requireEnabled();
      const state = await this.load();
      const account = state.accounts.find((a) => a.id === (accountId ?? state.activeId));
      if (!account?.credentials) throw new ChatGptAuthError('SIGN_IN_REQUIRED');
      if (!account.planEnabled) throw new ChatGptAuthError('PLAN_PERMISSION_REQUIRED');
      const c = account.credentials;
      if (this.now() >= c.expiresAt - (this.options.refreshSkewMs ?? 60_000) && this.now() >= c.earliestRefreshAt) {
        try {
          const tokens = await this.exchange(
            new URLSearchParams({
              grant_type: 'refresh_token',
              client_id: account.clientId,
              refresh_token: c.refreshToken,
              resource,
            }),
          );
          if (tokens.client_id && tokens.client_id !== account.clientId)
            throw new ChatGptAuthError('CLIENT_ID_MISMATCH');
          if (tokens.id_token) {
            const identity = await this.identity(tokens.id_token, account.clientId);
            if (identity.sub !== account.subject || (identity.nonce !== undefined && identity.nonce !== c.nonce))
              throw new ChatGptAuthError('ACCOUNT_MISMATCH');
          }
          account.credentials = this.credentials(tokens, c.nonce, c);
          account.planEnabled =
            account.credentials.scopes.includes('chatgpt.tokens.use.direct') &&
            account.credentials.scopes.includes('resource.invoke');
          await this.save(state);
        } catch (error) {
          if (error instanceof ChatGptAuthError && terminalRefresh.has(error.code)) {
            delete account.credentials;
            account.signedIn = false;
            account.planEnabled = false;
            this.stopSession(account.id);
            await this.save(state);
          }
          throw error instanceof ChatGptAuthError ? error : new ChatGptAuthError('REFRESH_FAILED');
        }
      }
      this.requireEnabled();
      if (!account.planEnabled) throw new ChatGptAuthError('PLAN_PERMISSION_REQUIRED');
      if (this.now() >= account.credentials.expiresAt) throw new ChatGptAuthError('TOKEN_EXPIRED');
      return account.credentials.accessToken;
    });
  }
  private stopSession(id: string) {
    this.sessions.get(id)?.abort();
    this.sessions.delete(id);
  }
  createProvider(accountId: string): OpenAIResponsesProvider {
    this.requireEnabled();
    if (!this.sessions.has(accountId)) this.sessions.set(accountId, new AbortController());
    const session = this.sessions.get(accountId)!;
    return new OpenAIResponsesProvider({
      mode: 'chatgpt',
      apiKey: () => this.getAccessToken(accountId),
      baseURL: this.options.apiBaseURL ?? resource,
      fetch: (input, init) => {
        this.requireEnabled();
        session.signal.throwIfAborted();
        return this.fetcher(input, {
          ...init,
          signal: AbortSignal.any([session.signal, ...(init?.signal ? [init.signal] : [])]),
        });
      },
    });
  }
  async listModels(accountId: string) {
    return this.createProvider(accountId).listModels();
  }
  async signOut(accountId: string): Promise<{ remoteRevocationConfirmed: boolean }> {
    this.stopSession(accountId);
    return exclusive(this.options.store, async () => {
      const state = await this.load();
      const account = state.accounts.find((a) => a.id === accountId);
      if (!account) throw new ChatGptAuthError('ACCOUNT_NOT_FOUND');
      let confirmed = false;
      try {
        const d = await this.configuration();
        if (account.credentials && d.revocation_endpoint)
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const response = await this.fetcher(d.revocation_endpoint, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                  token: account.credentials.refreshToken,
                  token_type_hint: 'refresh_token',
                  client_id: account.clientId,
                }).toString(),
                signal: AbortSignal.timeout(10_000),
                redirect: 'error',
              });
              if (response.status === 200) {
                confirmed = true;
                break;
              }
              if (response.status < 500) break;
            } catch {
              /* Network failure: retry while the refresh token is still available. */
            }
            if (attempt < 2) await new Promise<void>((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
          }
      } catch {
        /* Local sign-out still succeeds; caller displays the revocation outcome. */
      }
      delete account.credentials;
      account.signedIn = false;
      account.planEnabled = false;
      if (state.activeId === accountId) delete state.activeId;
      await this.save(state);
      return { remoteRevocationConfirmed: confirmed };
    });
  }
}
