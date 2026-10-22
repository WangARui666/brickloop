import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

/** Local OAuth fixture using the same discovery, PKCE and signed identity flow as auth.test.ts. */
export async function fakeOAuth() {
  const keys = await generateKeyPair('RS256');
  const controls = { account: 1, modelsFail: false, models: ['gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna'] };
  const requests: Record<string, unknown>[] = [];
  let origin = '',
    pending = new URLSearchParams(),
    registrations = 0;
  const server = createServer((req, res) => {
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
      } else if (url.pathname === '/jwks') {
        res.end(
          JSON.stringify({
            keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'test-key', use: 'sig', alg: 'RS256' }],
          }),
        );
      } else if (url.pathname === '/authorize') {
        pending = url.searchParams;
        const callback = new URL(pending.get('redirect_uri')!);
        callback.searchParams.set('state', pending.get('state')!);
        callback.searchParams.set('code', 'local-code');
        callback.searchParams.set('client_id', `oaiapp_test_${++registrations}`);
        res.writeHead(302, { location: callback.toString() }).end();
      } else if (url.pathname === '/token') {
        let body = '';
        for await (const chunk of req) body += String(chunk);
        const params = new URLSearchParams(body);
        if (
          createHash('sha256').update(params.get('code_verifier')!).digest('base64url') !==
          pending.get('code_challenge')
        )
          throw new Error('PKCE');
        const token = await new SignJWT({
          nonce: pending.get('nonce'),
          email: `builder${controls.account}@example.test`,
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
          .setIssuer(origin)
          .setAudience(params.get('client_id')!)
          .setSubject(`subject-${controls.account}`)
          .setIssuedAt()
          .setExpirationTime('1h')
          .sign(keys.privateKey);
        res.end(
          JSON.stringify({
            access_token: 'fake-access',
            refresh_token: 'fake-refresh',
            id_token: token,
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
          }),
        );
      } else if (url.pathname === '/revoke') res.end();
      else if (url.pathname === '/v1/models') {
        if (controls.modelsFail)
          res.writeHead(403).end(JSON.stringify({ error: { message: 'Fixture model list unavailable' } }));
        else
          res.end(
            JSON.stringify({
              models: controls.models.map((slug) => ({ slug, display_name: slug, visibility: 'list' })),
            }),
          );
      } else if (url.pathname === '/v1/responses') {
        let body = '';
        for await (const chunk of req) body += String(chunk);
        requests.push(JSON.parse(body) as Record<string, unknown>);
        res.setHeader('content-type', 'text/event-stream');
        res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'OK' })}\n\n`);
        res.end(
          `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'offline-response', output: [], usage: { input_tokens: 8, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } } })}\n\n`,
        );
      } else res.writeHead(404).end();
    })().catch(() => {
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('PORT');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    controls,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
