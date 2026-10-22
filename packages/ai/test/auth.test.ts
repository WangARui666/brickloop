import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatGptAuth } from '../src/node/index.js';
import type { SecretStore } from '../src/secrets.js';
import { SecretUnreadableError } from '../src/secrets.js';

const originalFetch = globalThis.fetch;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
});
class MemoryStore implements SecretStore {
  values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key);
  }
  async set(key: string, value: string) {
    this.values.set(key, value);
  }
  async delete(key: string) {
    this.values.delete(key);
  }
}
let server: Server;
let origin: string;
let now: number;
let store: MemoryStore;
let authorizeRequests: URLSearchParams[];
let tokenRequests: URLSearchParams[];
let invalid:
  | 'state'
  | 'access_denied'
  | 'client'
  | 'nonce'
  | 'subject'
  | 'audience'
  | 'issuer'
  | 'expiry'
  | 'signature'
  | 'scope'
  | 'refresh'
  | undefined;
let refreshCount: number;
let revokeCount: number;
let revokeStatus: number;
let accountNumber: number;
let pending: URLSearchParams;
const localFetch: typeof fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
  if (url.hostname !== '127.0.0.1') throw new Error(`REAL NETWORK IS FORBIDDEN: ${url.hostname}`);
  return originalFetch(input, init);
};
beforeEach(async () => {
  vi.stubGlobal('fetch', localFetch);
  now = Date.now();
  store = new MemoryStore();
  authorizeRequests = [];
  tokenRequests = [];
  invalid = undefined;
  refreshCount = 0;
  revokeCount = 0;
  revokeStatus = 200;
  accountNumber = 1;
  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', origin);
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/.well-known/openid-configuration') {
        res.end(
          JSON.stringify({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            jwks_uri: `${origin}/jwks`,
            revocation_endpoint: `${origin}/revoke`,
          }),
        );
        return;
      }
      if (url.pathname === '/jwks') {
        res.end(
          JSON.stringify({
            keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'test-key', use: 'sig', alg: 'RS256' }],
          }),
        );
        return;
      }
      if (url.pathname === '/authorize') {
        pending = url.searchParams;
        authorizeRequests.push(pending);
        const callback = new URL(pending.get('redirect_uri')!);
        callback.searchParams.set('state', invalid === 'state' ? 'wrong-state' : pending.get('state')!);
        if (invalid === 'access_denied') callback.searchParams.set('error', 'access_denied');
        else {
          callback.searchParams.set('code', 'local-code');
          if (pending.get('client_id') === 'dynamic_agent_client')
            callback.searchParams.set('client_id', `oaiapp_${accountNumber}`);
          else if (invalid === 'client') callback.searchParams.set('client_id', 'different-client');
        }
        res.writeHead(302, { location: callback.toString() }).end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += String(chunk);
      const params = new URLSearchParams(body);
      if (url.pathname === '/revoke') {
        revokeCount++;
        res.statusCode = revokeStatus;
        res.end();
        return;
      }
      if (url.pathname === '/token') {
        tokenRequests.push(params);
        if (params.get('grant_type') === 'refresh_token') {
          refreshCount++;
          if (invalid === 'refresh') {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'invalid_grant' }));
            return;
          }
        } else {
          expect(params.get('redirect_uri')).toBe(pending.get('redirect_uri'));
          expect(createHash('sha256').update(params.get('code_verifier')!).digest('base64url')).toBe(
            pending.get('code_challenge'),
          );
        }
        const signing = invalid === 'signature' ? await generateKeyPair('RS256') : keys;
        const jwt = await new SignJWT({
          nonce: invalid === 'nonce' ? 'wrong' : pending.get('nonce'),
          email: 'same@example.test',
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
          .setIssuer(invalid === 'issuer' ? 'https://invalid.test' : origin)
          .setAudience(invalid === 'audience' ? 'wrong-client' : params.get('client_id')!)
          .setSubject(invalid === 'subject' ? 'wrong-subject' : `subject-${accountNumber}`)
          .setIssuedAt(Math.floor(now / 1000))
          .setExpirationTime(Math.floor(now / 1000) + (invalid === 'expiry' ? -100 : 7200))
          .sign(signing.privateKey);
        res.end(
          JSON.stringify({
            access_token: `access-${refreshCount}`,
            refresh_token: `refresh-${refreshCount}`,
            id_token: jwt,
            token_type: 'Bearer',
            expires_in: 3600,
            scope:
              invalid === 'scope'
                ? 'openid profile email'
                : 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
            earliest_refresh_at: Math.floor(now / 1000),
          }),
        );
        return;
      }
      if (url.pathname === '/v1/models') {
        res.end(
          JSON.stringify({
            models: [
              { slug: 'allowed', display_name: 'Allowed', visibility: 'list' },
              { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
            ],
          }),
        );
        return;
      }
      res.writeHead(404).end();
    })().catch(() => {
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllGlobals();
});
function auth(overrides: Partial<ConstructorParameters<typeof ChatGptAuth>[0]> = {}) {
  return new ChatGptAuth({
    store,
    issuer: origin,
    apiBaseURL: `${origin}/v1`,
    fetch: localFetch,
    now: () => now,
    openExternal: async (url) => {
      await localFetch(url);
    },
    ...overrides,
  });
}
it.each([new SecretUnreadableError(), new Error('SECURE_STORAGE_UNAVAILABLE')])(
  'keeps unreadable accounts intact across reads and refresh, and replaces only on successful sign-in: %s',
  async (error) => {
    const client = auth();
    const account = await client.signIn();
    const original = [...store.values.entries()];
    const get = vi.spyOn(store, 'get').mockRejectedValue(error);
    const set = vi.spyOn(store, 'set');
    const requests = tokenRequests.length;
    now += 3_550_000;
    expect(await client.accounts()).toEqual({ accounts: [], unreadable: true });
    expect(await auth().accounts()).toEqual({ accounts: [], unreadable: true });
    await expect(client.getAccessToken(account.id)).rejects.toBe(error);
    expect(tokenRequests).toHaveLength(requests);
    expect(set).not.toHaveBeenCalled();
    expect([...store.values.entries()]).toEqual(original);
    get.mockRestore();
    expect((await client.accounts()).accounts).toEqual([account]);
    vi.spyOn(store, 'get').mockRejectedValue(error);
    invalid = 'access_denied';
    await expect(client.signIn()).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(set).not.toHaveBeenCalled();
    expect([...store.values.entries()]).toEqual(original);
    invalid = undefined;
    const replacement = await client.signIn();
    expect(replacement.signedIn).toBe(true);
    expect(set).toHaveBeenCalledTimes(1);
    expect([...store.values.entries()]).not.toEqual(original);
    vi.restoreAllMocks();
    expect((await client.accounts()).accounts).toEqual([replacement]);
  },
);
it('does not create saved state while listing a new account store', async () => {
  expect(await auth().accounts()).toEqual({ accounts: [] });
  expect(store.values.size).toBe(0);
});
it('keeps the account identity when the same subject reauthorizes with a newly registered client', async () => {
  const client = auth();
  const first = await client.signIn();
  const second = await client.signIn({ registrationClientId: 'oaiapp_new' });
  expect(second.id).toBe(first.id);
  expect(second.clientId).toBe('oaiapp_new');
  expect((await client.accounts()).accounts).toHaveLength(1);
});
it('registers once, reauthorizes with fresh challenges and refreshes the saved session atomically', async () => {
  const client = auth();
  const account = await client.signIn();
  expect(account).toMatchObject({ clientId: 'oaiapp_1', subject: 'subject-1', signedIn: true, planEnabled: true });
  const first = authorizeRequests[0]!;
  expect(first.get('client_id')).toBe('dynamic_agent_client');
  expect(first.get('agent_name_hint')).toBe('Brickloop');
  expect(first.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
  expect(first.get('resource')).toBe('https://api.openai.com/v1');
  expect(first.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  expect(tokenRequests[0]?.get('client_id')).toBe('oaiapp_1');
  expect(await auth().getAccessToken(account.id)).toBe('access-0');
  await client.signIn({ accountId: account.id });
  const second = authorizeRequests[1]!;
  expect(second.get('client_id')).toBe('oaiapp_1');
  expect(second.has('agent_name_hint')).toBe(false);
  expect(second.get('id_token_hint')).toMatch(/^eyJ/);
  expect(second.get('ext_agent_host_id')).toBe(first.get('ext_agent_host_id'));
  for (const key of ['state', 'nonce', 'code_challenge']) expect(second.get(key)).not.toBe(first.get(key));
  now += 3_550_000;
  expect(await Promise.all([client.getAccessToken(account.id), auth().getAccessToken(account.id)])).toEqual([
    'access-1',
    'access-1',
  ]);
  expect(refreshCount).toBe(1);
  expect(tokenRequests.at(-1)?.has('scope')).toBe(false);
  expect(tokenRequests.at(-1)?.get('refresh_token')).toBe('refresh-0');
  expect(await client.listModels(account.id)).toEqual([{ id: 'allowed', name: 'Allowed' }]);
});
it.each(['state', 'access_denied'] as const)('rejects %s without exchanging a code', async (failure) => {
  invalid = failure;
  await expect(auth().signIn()).rejects.toMatchObject({
    code: failure === 'state' ? 'STATE_MISMATCH' : 'ACCESS_DENIED',
  });
  expect(tokenRequests).toHaveLength(0);
  expect((await auth().accounts()).accounts).toEqual([]);
});
it.each(['nonce', 'audience', 'issuer', 'expiry', 'signature'] as const)('validates ID token %s', async (failure) => {
  invalid = failure;
  await expect(auth().signIn()).rejects.toMatchObject({ code: 'INVALID_ID_TOKEN' });
  expect((await auth().accounts()).accounts).toEqual([]);
});
it.each(['client', 'subject'] as const)('does not overwrite the selected account on %s mismatch', async (failure) => {
  const client = auth();
  const account = await client.signIn();
  const original = [...store.values.values()];
  invalid = failure;
  await expect(client.signIn({ accountId: account.id })).rejects.toMatchObject({
    code: failure === 'client' ? 'CLIENT_ID_MISMATCH' : 'ACCOUNT_MISMATCH',
  });
  expect([...store.values.values()]).toEqual(original);
});
it('keeps same-email registrations separate and preserves mappings after sign-out', async () => {
  const client = auth();
  const a = await client.signIn();
  accountNumber = 2;
  const b = await client.signIn();
  expect(a.id).not.toBe(b.id);
  expect((await client.accounts()).accounts).toHaveLength(2);
  await client.selectAccount(a.id);
  expect((await client.accounts()).activeId).toBe(a.id);
  expect(await client.signOut(a.id)).toEqual({ remoteRevocationConfirmed: true });
  expect(revokeCount).toBe(1);
  const accounts = await client.accounts();
  expect(accounts.accounts.find((v) => v.id === a.id)).toMatchObject({ clientId: a.clientId, signedIn: false });
  expect(accounts.accounts.find((v) => v.id === b.id)?.signedIn).toBe(true);
  accountNumber = 1;
  await client.signIn({ accountId: a.id });
  expect(authorizeRequests.at(-1)?.has('id_token_hint')).toBe(false);
  expect(authorizeRequests.at(-1)?.get('client_id')).toBe(a.clientId);
});
it('stores identity without plan scope, but prevents inference and supports an explicit consent retry', async () => {
  invalid = 'scope';
  const client = auth();
  const account = await client.signIn();
  expect(account.planEnabled).toBe(false);
  await expect(client.getAccessToken(account.id)).rejects.toMatchObject({ code: 'PLAN_PERMISSION_REQUIRED' });
  invalid = undefined;
  await client.signIn({ accountId: account.id, requestPlanConsent: true });
  expect(authorizeRequests.at(-1)?.get('prompt')).toBe('consent');
});
it('clears an unusable rotating token, retains registration, and obeys the feature switch', async () => {
  const client = auth();
  const account = await client.signIn();
  now += 3_550_000;
  invalid = 'refresh';
  await expect(client.getAccessToken(account.id)).rejects.toMatchObject({ code: 'invalid_grant' });
  expect((await client.accounts()).accounts[0]).toMatchObject({ signedIn: false, clientId: 'oaiapp_1' });
  client.setEnabled(false);
  await expect(client.signIn()).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
  expect(() => client.createProvider(account.id)).toThrow();
});
it('reports unconfirmed remote revocation while clearing local tokens', async () => {
  const client = auth();
  const account = await client.signIn();
  revokeStatus = 503;
  expect(await client.signOut(account.id)).toEqual({ remoteRevocationConfirmed: false });
  expect(revokeCount).toBe(3);
  await expect(client.getAccessToken(account.id)).rejects.toMatchObject({ code: 'SIGN_IN_REQUIRED' });
});
describe('callback lifetime', () => {
  it('closes the listener when browser opening fails', async () => {
    let callbackURL = '';
    const client = auth({
      openExternal: async (url) => {
        callbackURL = new URL(url).searchParams.get('redirect_uri')!;
        throw new Error('browser unavailable');
      },
    });
    await expect(client.signIn()).rejects.toMatchObject({ code: 'LOGIN_FAILED' });
    await expect(localFetch(callbackURL)).rejects.toThrow();
  });
  it('supports cancellation while waiting for the user', async () => {
    const controller = new AbortController();
    const client = auth({
      openExternal: async () => {
        controller.abort();
      },
    });
    await expect(client.signIn({ signal: controller.signal })).rejects.toMatchObject({ code: 'LOGIN_CANCELLED' });
  });
  it('reports a timeout when the browser never calls back', async () => {
    const client = auth({ loginTimeoutMs: 50, openExternal: async () => undefined });
    await expect(client.signIn()).rejects.toMatchObject({ code: 'LOGIN_TIMEOUT' });
  });
});
