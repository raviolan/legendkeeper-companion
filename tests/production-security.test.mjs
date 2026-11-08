import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';

const production = 'https://legendkeeper-companion.pink-void.workers.dev';
const bundle = await build({
  stdin: { contents: "export {default as worker} from './worker/index'; export {handleOAuthRequest} from './worker/oauth'; export {verifyGoogleIdToken} from './worker/google';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'import'], external: ['node:*'],
  plugins: [{ name: 'cloudflare-test-entrypoint', setup(build) {
    build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export class WorkerEntrypoint {}' }));
  } }],
});
const { worker, handleOAuthRequest, verifyGoogleIdToken } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const env = { MCP_BASE_URL: production, ALLOWED_GITHUB_USER_ID: '180304956',
  GITHUB_CLIENT_ID: 'test-id', GITHUB_CLIENT_SECRET: 'test-secret', LEGENDKEEPER_API_KEY: 'test-key',
  OAUTH_KV: { async get() { return null; } } };
const ctx = { waitUntil() {} };

test('production config has one real KV binding, no local/secret values, and required secrets', async () => {
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  assert.equal(config.name, 'legendkeeper-companion');
  assert.equal(config.main, 'worker/index.ts');
  assert.ok(config.compatibility_flags.includes('global_fetch_strictly_public'));
  assert.equal(config.vars.MCP_BASE_URL, production);
  assert.equal(config.vars.ALLOWED_GITHUB_USER_ID, '180304956');
  assert.equal(config.vars.MCP_DEV_DIAGNOSTICS, 'false');
  assert.equal(config.vars.MCP_CORS_ORIGIN, undefined);
  assert.equal(config.kv_namespaces.length, 1);
  assert.equal(config.kv_namespaces[0].binding, 'OAUTH_KV');
  assert.match(config.kv_namespaces[0].id, /^[a-f0-9]{32}$/);
  assert.notEqual(config.kv_namespaces[0].id, '0'.repeat(32));
  assert.notEqual(config.kv_namespaces[0].remote, true);
  assert.deepEqual(config.secrets.required.sort(), ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'LEGENDKEEPER_API_KEY']);
  for (const name of config.secrets.required) assert.equal(config.vars[name], undefined);
  const example = JSON.parse(await readFile('.secrets.production.example.json', 'utf8'));
  assert.deepEqual(Object.keys(example).sort(), ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'LEGENDKEEPER_API_KEY', 'LEGENDKEEPER_API_KEY_HUSBAND'].sort());
  assert.ok(Object.values(example).every(value => value === ''));
  for (const secret of Object.keys(example)) assert.equal(config.vars[secret], undefined);
  const source = bundle.outputFiles[0].text;
  assert.doesNotMatch(source, /\/test\/authorize|test-unused-key/);
});

test('production discovery uses only the HTTPS issuer/resource and advertises refresh tokens', async () => {
  const metadata = await worker.fetch(new Request(`${production}/.well-known/oauth-authorization-server`), { ...env }, ctx);
  assert.equal(metadata.status, 200);
  const auth = await metadata.json();
  assert.equal(auth.issuer, production);
  assert.equal(auth.authorization_endpoint, `${production}/authorize`);
  assert.equal(auth.token_endpoint, `${production}/oauth/token`);
  assert.ok(auth.grant_types_supported.includes('refresh_token'));
  assert.ok(auth.scopes_supported.includes('offline_access'));
  assert.ok(auth.code_challenge_methods_supported.includes('S256'));
  const resource = await worker.fetch(new Request(`${production}/.well-known/oauth-protected-resource/mcp`), { ...env }, ctx);
  assert.equal(resource.status, 200);
  const protectedResource = await resource.json();
  assert.equal(protectedResource.resource, `${production}/mcp`);
  assert.deepEqual(protectedResource.authorization_servers, [production]);
});

test('anonymous and invalid-token tool calls cannot reach upstream; foreign browser origins are rejected', async (t) => {
  let upstreamCalls = 0;
  t.mock.method(globalThis, 'fetch', () => { upstreamCalls++; throw new Error('Unexpected upstream access'); });
  for (const method of ['GET', 'POST', 'DELETE']) {
    for (const token of [undefined, 'invalid-token']) {
      const response = await worker.fetch(new Request(`${production}/mcp`, {
        method, headers: token ? { Authorization: `Bearer ${token}` } : {},
        ...(method === 'POST' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_pages', arguments: {} } }) } : {}),
      }), { ...env }, ctx);
      assert.equal(response.status, 401);
      assert.match(response.headers.get('WWW-Authenticate'), /oauth-protected-resource/);
    }
  }
  const blocked = await worker.fetch(new Request(`${production}/mcp`, { method: 'POST', headers: { Origin: 'https://evil.example' } }), { ...env }, ctx);
  assert.equal(blocked.status, 403);
  assert.equal(upstreamCalls, 0);
});

test('async OAuth failures are caught and never expose upstream errors', async () => {
  for (const [path, method, provider] of [
    ['/authorize', 'GET', { parseAuthRequest: async () => { throw new Error('test-secret'); } }],
    ['/authorize', 'POST', { denyConsent: async () => { throw new Error('test-secret'); } }],
    ['/callback?code=private', 'GET', { finishUpstream: async () => { throw new Error('test-secret'); } }],
  ]) {
    const request = new Request(`${production}${path}`, { method,
      ...(method === 'POST' ? { body: new URLSearchParams({ handle: 'test', decision: 'deny' }) } : {}) });
    const response = await handleOAuthRequest(request, { ...env, OAUTH_PROVIDER: provider });
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /test-secret|private/);
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  }
});

test('consent page escapes client metadata and has browser security headers', async () => {
  const response = await handleOAuthRequest(new Request(`${production}/authorize`), { ...env,
    OAUTH_PROVIDER: { parseAuthRequest: async () => ({}),
      describeConsent: async () => ({ clientName: '<script>bad</script>', redirectHost: 'client.example', scope: ['mcp:read', 'offline_access'] }),
      beginConsent: async () => ({ handle: 'test', headers: new Headers() }),
    } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.text();
  assert.doesNotMatch(body, /<script>/);
  assert.match(body, /&#60;script&#62;/);
});

// The actual provider mints/validates consent handles and cookies. Only storage
// is in-memory; no consent or CSRF validation method is mocked.
async function consentSession(redirectUri = 'http://localhost:6274/callback', overrides = {}, values = new Map()) {
  const testEnv = { ...env, ...overrides, OAUTH_KV: {
    async get(key, options) {
      const value = values.get(key) ?? null;
      return value && (options === 'json' || options?.type === 'json') ? JSON.parse(value) : value;
    },
    async put(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    async list({ prefix = '' } = {}) {
      return { keys: [...values.keys()].filter(name => name.startsWith(prefix)).map(name => ({ name })), list_complete: true };
    },
  } };
  const pending = [];
  const context = { waitUntil(promise) { pending.push(promise); } };
  const send = (path, options) => worker.fetch(new Request(`${production}${path}`, options), { ...testEnv }, context);
  const registration = await send('/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Consent regression', redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  assert.equal(registration.status, 201);
  const metadata = await registration.json();
  const client = { clientId: metadata.client_id, redirectUris: metadata.redirect_uris };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('a'.repeat(64)));
  const challenge = Buffer.from(digest).toString('base64url');
  const params = new URLSearchParams({ client_id: client.clientId, response_type: 'code',
    redirect_uri: client.redirectUris[0], resource: `${production}/mcp`, scope: 'mcp:read offline_access',
    code_challenge: challenge, code_challenge_method: 'S256', state: 'client-state',
  });
  const response = await send(`/authorize?${params}`);
  assert.equal(response.status, 200);
  const html = await response.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  assert.ok(handle);
  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.some(cookie => cookie.startsWith('__Host-oauth-consent-')));
  for (const cookie of cookies) {
    assert.match(cookie, /Secure/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
  }
  const cookie = cookies.map(value => value.split(';')[0]).join('; ');
  const post = (formHandle = handle, browserCookie = cookie, provider = 'github', scopes = ['mcp:read']) => send('/authorize', {
    method: 'POST', headers: { Origin: 'null', 'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document',
      ...(browserCookie ? { Cookie: browserCookie } : {}) },
    body: new URLSearchParams([['handle', formHandle], ['decision', 'approve'], ['provider', provider], ...scopes.map(scope => ['scope', scope])]),
  });
  return { send, post, handle, cookie, values, pending, environment: testEnv, consentResponse: response, html, client,
    verifier: 'a'.repeat(64), authorizePath: `/authorize?${params}` };
}

test('real OAuth consent accepts Origin null only with valid browser-bound consent state', async () => {
  const session = await consentSession();
  const approved = await session.post();
  assert.equal(approved.status, 302);
  const next = new URL(approved.headers.get('Location'));
  assert.equal(next.origin, 'https://github.com');
  assert.equal(next.pathname, '/login/oauth/authorize');
  assert.equal(next.searchParams.get('redirect_uri'), `${production}/callback`);
  assert.equal(next.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(next.searchParams.get('code_challenge'));
  assert.ok(next.searchParams.get('state'));
  assert.ok(approved.headers.getSetCookie().some(cookie => cookie.startsWith('__Host-oauth-upstream-')));
  // Consent alone never issues MCP access or makes a LegendKeeper read.
  assert.equal(next.searchParams.has('access_token'), false);
  const replay = await session.post();
  assert.equal(replay.status, 400);
  assert.equal(replay.headers.get('Location'), null);
  await Promise.all(session.pending);
});

test('Origin null and same-origin fetch metadata cannot bypass consent state or cookie validation', async () => {
  const session = await consentSession();
  for (const [handle, cookie] of [
    ['', session.cookie], ['forged-handle', session.cookie], [session.handle, ''],
    [session.handle, '__Host-oauth-consent-forged=forged'],
  ]) {
    const response = await session.post(handle, cookie);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('Location'), null);
  }
  // A real handle with another browser transaction's cookie must fail as well.
  const otherBrowser = await consentSession();
  assert.equal((await session.post(session.handle, otherBrowser.cookie)).status, 400);
  session.values.clear();
  assert.equal((await session.post()).status, 400);
  await Promise.all([...session.pending, ...otherBrowser.pending]);
});

test('null Origin remains rejected for MCP routes and their protected descendants', async () => {
  for (const path of ['/mcp', '/mcp/', '/mcp/nested']) {
    const response = await worker.fetch(new Request(`${production}${path}`, {
      method: 'POST', headers: { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' },
    }), { ...env }, ctx);
    assert.equal(response.status, 403);
    assert.equal(await response.text(), 'Origin not allowed');
  }
});


test('consent CSP retains content and anti-framing restrictions without constraining registered-client redirects', async () => {
  const session = await consentSession();
  const cspHeaders = [...session.consentResponse.headers].filter(([name]) => name === 'content-security-policy');
  assert.equal(cspHeaders.length, 1);
  const policy = cspHeaders[0][1];
  assert.equal(policy.includes(','), false, 'No additional intersecting CSP policy');
  const directives = policy.split(';').map(value => value.trim().split(/\s+/));
  assert.equal(directives.some(([name]) => name === 'form-action'), false);
  assert.doesNotMatch(policy, /\*/);
  assert.deepEqual(directives.find(([name]) => name === 'default-src'), ['default-src', "'none'"]);
  assert.deepEqual(directives.find(([name]) => name === 'frame-ancestors'), ['frame-ancestors', "'none'"]);
  assert.deepEqual(directives.find(([name]) => name === 'base-uri'), ['base-uri', "'none'"]);
  assert.equal(session.consentResponse.headers.get('X-Frame-Options'), 'DENY');
  assert.doesNotMatch(session.html, /http-equiv\s*=\s*["']Content-Security-Policy/i);
  const form = session.html.match(/<form method="post" action="([^"]+)"/);
  assert.ok(form);
  assert.equal(new URL(form[1], production).href, `${production}/authorize`);
  const approved = await session.post();
  assert.equal(approved.status, 302);
  const next = new URL(approved.headers.get('Location'));
  assert.equal(next.origin, 'https://github.com');
  assert.equal(next.pathname, '/login/oauth/authorize');
  assert.equal((await session.post()).status, 400, 'Consent remains one-use');
  await Promise.all(session.pending);
});

function browserCookies(response) {
  return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
}

for (const redirectUri of ['https://client-one.example/oauth/return', 'https://client-two.example/custom/callback']) {
  test(`OAuth returns only to the registered dynamic callback ${redirectUri}`, async (t) => {
    const session = await consentSession(redirectUri);
    // The browser's initial form always submits locally, not to this dynamic URI.
    assert.match(session.html, /<form method="post" action="\/authorize">/);
    assert.doesNotMatch(session.consentResponse.headers.get('Content-Security-Policy'), /form-action/);
    const github = await session.post();
    assert.equal(github.status, 302);
    const state = new URL(github.headers.get('Location')).searchParams.get('state');
    const cookies = browserCookies(github);
    const callbackPath = `/callback?${new URLSearchParams({ code: 'test-github-code', state })}`;
    let githubCalls = 0;
    t.mock.method(globalThis, 'fetch', async (input, options) => {
      githubCalls++;
      if (input === 'https://github.com/login/oauth/access_token') {
        assert.equal(options.body.get('redirect_uri'), `${production}/callback`);
        assert.ok(options.body.get('code_verifier'));
        return Response.json({ access_token: 'test-github-token' });
      }
      assert.equal(input, 'https://api.github.com/user');
      assert.equal(options.headers.Authorization, 'Bearer test-github-token');
      return Response.json({ id: 180304956 });
    });
    // Matching upstream state without its browser cookie must fail before GitHub.
    assert.equal((await session.send(callbackPath)).status, 400);
    assert.equal(githubCalls, 0);
    const callback = await session.send(callbackPath, { headers: { Cookie: cookies } });
    assert.equal(callback.status, 302);
    const destination = new URL(callback.headers.get('Location'));
    assert.equal(destination.origin + destination.pathname, redirectUri);
    assert.ok(destination.searchParams.get('code'));
    assert.equal(destination.searchParams.get('state'), 'client-state');
    assert.equal(destination.searchParams.get('iss'), production);
    assert.equal(destination.searchParams.has('access_token'), false);
    assert.equal(githubCalls, 2);
    assert.equal((await session.send(callbackPath, { headers: { Cookie: cookies } })).status, 400);
    const code = destination.searchParams.get('code');
    const exchange = verifier => session.send('/oauth/token', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
        grant_type: 'authorization_code', code, client_id: session.client.clientId,
        code_verifier: verifier, redirect_uri: redirectUri, resource: `${production}/mcp`,
      }),
    });
    assert.equal((await exchange('wrong-verifier')).status, 400);
    const tokenResponse = await exchange(session.verifier);
    assert.equal(tokenResponse.status, 200);
    const token = await tokenResponse.json();
    assert.ok(token.access_token);
    assert.equal(token.scope, 'mcp:read');
    const initialization = await session.send('/mcp', { method: 'POST', headers: {
      Host: new URL(production).host, Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'callback-regression', version: '1' },
    } }) });
    assert.equal(initialization.status, 200);
    const body = await initialization.text();
    const initialized = JSON.parse(body.split('\n').find(line => line.startsWith('data:')).slice(5));
    assert.equal(initialized.result.protocolVersion, '2025-11-25');
    await Promise.all(session.pending);
  });
}

test('unregistered redirect substitution is rejected before consent', async () => {
  const session = await consentSession('https://registered-client.example/callback');
  const forged = new URL(session.authorizePath, production);
  forged.searchParams.set('redirect_uri', 'https://attacker.example/callback');
  const response = await session.send(forged.pathname + forged.search);
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('Location'), null);
  await Promise.all(session.pending);
});


const googleEnv = { LEGENDKEEPER_API_KEY_HUSBAND: 'husband-test-key', GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'google-secret', ALLOWED_GOOGLE_SUB: 'husband-sub' };
const googleKey = await generateKeyPair('RS256');
const publicJwk = { ...await exportJWK(googleKey.publicKey), kid: 'google-test', alg: 'RS256', use: 'sig' };
const localGoogleKeys = createLocalJWKSet({ keys: [publicJwk] });
async function googleToken(nonce, claims = {}, key = googleKey.privateKey) {
  return new SignJWT({ iss: 'https://accounts.google.com', aud: googleEnv.GOOGLE_CLIENT_ID,
    sub: googleEnv.ALLOWED_GOOGLE_SUB, iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600, nonce, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'google-test' }).sign(key);
}

test('Google ID token verification rejects wrong issuer, audience, expiry, nonce, signature and authorized party', async () => {
  assert.equal(await verifyGoogleIdToken(await googleToken('nonce'), 'google-client', 'nonce', localGoogleKeys), 'husband-sub');
  assert.equal(await verifyGoogleIdToken(await googleToken('nonce', { iss: 'accounts.google.com' }), 'google-client', 'nonce', localGoogleKeys), 'husband-sub');
  for (const claims of [{ iss: 'https://evil.example' }, { aud: 'other-client' }, { exp: 1 },
    { nonce: 'other-nonce' }, { nonce: undefined }, { sub: '' }, { exp: undefined },
    { iat: Math.floor(Date.now() / 1000) + 3600 }, { azp: 'other-client' },
    { aud: ['google-client', 'other-client'] }]) {
    await assert.rejects(verifyGoogleIdToken(await googleToken('nonce', claims), 'google-client', 'nonce', localGoogleKeys));
  }
  const attacker = await generateKeyPair('RS256');
  await assert.rejects(verifyGoogleIdToken(await googleToken('nonce', {}, attacker.privateKey), 'google-client', 'nonce', localGoogleKeys));
  const unsigned = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') + '.'
    + Buffer.from(JSON.stringify({ sub: 'husband-sub' })).toString('base64url') + '.';
  await assert.rejects(verifyGoogleIdToken(unsigned, 'google-client', 'nonce', localGoogleKeys));
});

for (const provider of ['github', 'google']) {
  test(`${provider}: real consent, ChatGPT redirect, PKCE, per-client refresh and only read-only MCP tools`, async t => {
    const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
    const session = await consentSession(redirect, googleEnv);
    assert.match(session.html, /<option value="google">Google/);
    const approved = await session.post(session.handle, session.cookie, provider, ['mcp:read', 'offline_access']);
    assert.equal(approved.status, 302);
    const upstream = new URL(approved.headers.get('Location'));
    const isGoogle = provider === 'google';
    assert.equal(upstream.origin, isGoogle ? 'https://accounts.google.com' : 'https://github.com');
    if (isGoogle) {
      assert.equal(upstream.searchParams.get('scope'), 'openid');
      assert.ok(upstream.searchParams.get('nonce'));
      assert.equal(upstream.searchParams.has('access_type'), false);
    }
    const callback = isGoogle ? '/callback/google' : '/callback';
    const state = upstream.searchParams.get('state');
    const cookies = browserCookies(approved);
    let upstreamCalls = 0;
    t.mock.method(globalThis, 'fetch', async (input, options) => {
      upstreamCalls++;
      if (String(input) === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [publicJwk] });
      if (input === 'https://oauth2.googleapis.com/token') {
        assert.equal(options.body.get('redirect_uri'), `${production}/callback/google`);
        assert.equal(options.body.get('client_secret'), 'google-secret');
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(options.body.get('code_verifier')));
        assert.equal(Buffer.from(digest).toString('base64url'), upstream.searchParams.get('code_challenge'));
        return Response.json({ id_token: await googleToken(upstream.searchParams.get('nonce')) });
      }
      if (String(input).startsWith('https://www.legendkeeper.com/')) {
        assert.equal(options.method, 'GET');
        assert.equal(options.headers.authorization, isGoogle ? 'Bearer husband-test-key' : 'Bearer test-key');
        if (new URL(input).pathname.endsWith('/projects/')) return Response.json({ data: [{ id: 'project-1' }], hasMore: false });
        return Response.json({ data: [{ id: 'page-1', name: 'Read-only fixture' }], hasMore: false });
      }
      if (input === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'github-token' });
      assert.equal(input, 'https://api.github.com/user');
      return Response.json({ id: 180304956 });
    });
    const path = `${callback}?${new URLSearchParams({ state, code: 'code' })}`;
    assert.equal((await session.send(path)).status, 400);
    assert.equal(upstreamCalls, 0);
    const response = await session.send(path, { headers: { Cookie: cookies } });
    assert.equal(response.status, 302);
    const destination = new URL(response.headers.get('Location'));
    assert.equal(destination.origin + destination.pathname, redirect);
    assert.equal(destination.searchParams.get('state'), 'client-state');
    assert.equal(destination.searchParams.get('iss'), production);
    assert.ok(destination.searchParams.get('code'));
    assert.equal((await session.send(path, { headers: { Cookie: cookies } })).status, 400);
    const tokenRequest = data => session.send('/oauth/token', { method: 'POST', body: new URLSearchParams(data) });
    const grant = { grant_type: 'authorization_code', code: destination.searchParams.get('code'),
      client_id: session.client.clientId, redirect_uri: redirect, resource: `${production}/mcp`, code_verifier: session.verifier };
    assert.equal((await tokenRequest({ ...grant, code_verifier: 'wrong' })).status, 400);
    const tokenResponse = await tokenRequest(grant);
    assert.equal(tokenResponse.status, 200);
    const token = await tokenResponse.json();
    assert.ok(token.refresh_token);
    const anotherClient = await consentSession(redirect, googleEnv);
    const refresh = { grant_type: 'refresh_token', refresh_token: token.refresh_token,
      client_id: session.client.clientId, resource: `${production}/mcp` };
    assert.equal((await tokenRequest({ ...refresh, client_id: anotherClient.client.clientId })).status, 401);
    const renewedResponse = await tokenRequest(refresh);
    assert.equal(renewedResponse.status, 200);
    const renewed = await renewedResponse.json();
    assert.ok(renewed.refresh_token);
    assert.notEqual(renewed.refresh_token, token.refresh_token);
    const rpc = async (method, params = {}) => {
      const response = await session.send('/mcp', { method: 'POST', headers: {
        Authorization: `Bearer ${renewed.access_token}`, Host: new URL(production).host,
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25',
      }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      assert.equal(response.status, 200);
      const body = await response.text();
      return JSON.parse(body.split('\n').find(line => line.startsWith('data:')).slice(5));
    };
    const listed = await rpc('tools/list');
    assert.deepEqual(listed.result.tools.map(tool => tool.name).sort(), ['append_page', 'create_page', 'edit_page_block', 'list_pages', 'read_document_blocks', 'read_page', 'replace_page_content', 'search_campaign', 'update_resource']);
    assert.ok(listed.result.tools.filter(tool => ['list_pages', 'read_page', 'search_campaign', 'read_document_blocks'].includes(tool.name)).every(tool => tool.annotations.readOnlyHint));
    const read = await rpc('tools/call', { name: 'list_pages', arguments: { limit: 1 } });
    assert.notEqual(read.result.isError, true);
    assert.equal(JSON.parse(read.result.content[0].text).data[0].id, 'page-1');
    const beforeWrite = upstreamCalls;
    const write = await rpc('tools/call', { name: 'write_page', arguments: {} });
    assert.ok(write.error || write.result?.isError);
    assert.equal(upstreamCalls, beforeWrite);
    await Promise.all([...session.pending, ...anotherClient.pending]);
  });
}

for (const variant of ['unknown-sub', 'wrong-nonce', 'wrong-audience', 'wrong-issuer', 'expired', 'bad-signature', 'provider-substitution', 'missing-allowlist']) {
  test(`Google callback denies ${variant} without issuing an authorization code`, async t => {
    const session = await consentSession(undefined, { ...googleEnv, GOOGLE_SUB_DISCOVERY: 'true',
      ...(variant === 'missing-allowlist' ? { ALLOWED_GOOGLE_SUB: undefined } : {}) });
    const approved = await session.post(session.handle, session.cookie, 'google');
    const upstream = new URL(approved.headers.get('Location'));
    const state = upstream.searchParams.get('state');
    const nonce = upstream.searchParams.get('nonce');
    const claims = { 'unknown-sub': { sub: 'stranger' }, 'wrong-nonce': { nonce: 'wrong' },
      'wrong-audience': { aud: 'other' }, 'wrong-issuer': { iss: 'https://evil.example' }, expired: { exp: 1 } }[variant] ?? {};
    const key = variant === 'bad-signature' ? (await generateKeyPair('RS256')).privateKey : googleKey.privateKey;
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async input => {
      calls++;
      if (String(input) === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [publicJwk] });
      assert.equal(input, 'https://oauth2.googleapis.com/token');
      return Response.json({ id_token: await googleToken(nonce, claims, key) });
    });
    const callback = variant === 'provider-substitution' ? '/callback' : '/callback/google';
    const path = `${callback}?${new URLSearchParams({ state, code: 'code' })}`;
    const response = await session.send(path, { headers: { Cookie: browserCookies(approved) } });
    if (variant === 'provider-substitution') { assert.equal(response.status, 400); assert.equal(calls, 0); }
    else {
      assert.equal(response.status, 302);
      const destination = new URL(response.headers.get('Location'));
      assert.equal(destination.searchParams.get('error'), 'access_denied');
      assert.equal(destination.searchParams.has('code'), false);
    }
    assert.equal((await session.send(path, { headers: { Cookie: browserCookies(approved) } })).status, 400);
    await Promise.all(session.pending);
  });
}

test('GitHub transaction cannot be substituted into Google callback', async () => {
  const session = await consentSession(undefined, googleEnv);
  const approved = await session.post();
  const state = new URL(approved.headers.get('Location')).searchParams.get('state');
  const response = await session.send(`/callback/google?${new URLSearchParams({ state, code: 'code' })}`, {
    headers: { Cookie: browserCookies(approved) },
  });
  assert.equal(response.status, 400);
  await Promise.all(session.pending);
});


test('local Google subject discovery exposes only verified sub and never completes authorization', async t => {
  let completed = 0;
  t.mock.method(globalThis, 'fetch', async input => {
    if (String(input) === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [publicJwk] });
    assert.equal(input, 'https://oauth2.googleapis.com/token');
    return Response.json({ id_token: await googleToken('local-nonce'), access_token: 'must-not-be-exposed' });
  });
  const response = await handleOAuthRequest(new Request('http://localhost:8787/callback/google?code=private-code&state=bound'), {
    ...env, ...googleEnv, MCP_BASE_URL: 'http://localhost:8787', ALLOWED_GOOGLE_SUB: undefined, GOOGLE_SUB_DISCOVERY: 'true',
    OAUTH_PROVIDER: {
      finishUpstream: async () => ({ data: { provider: 'google', nonce: 'local-nonce', verifier: 'local-verifier' }, headers: new Headers() }),
      completeAuthorization: async () => { completed++; throw new Error('Discovery must not grant access'); },
    },
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Verified Google sub: husband-sub/);
  assert.doesNotMatch(html, /must-not-be-exposed|private-code|id_token/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(response.headers.get('Location'), null);
  assert.equal(completed, 0);
});

test('Google callback requires matching state and browser transaction before token exchange', async t => {
  const session = await consentSession(undefined, googleEnv);
  const other = await consentSession(undefined, googleEnv);
  const approved = await session.post(session.handle, session.cookie, 'google');
  const otherApproved = await other.post(other.handle, other.cookie, 'google');
  const state = new URL(approved.headers.get('Location')).searchParams.get('state');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => { calls++; throw new Error('No upstream access expected'); });
  for (const [value, cookies] of [['forged-state', browserCookies(approved)], [state, browserCookies(otherApproved)], ['', browserCookies(approved)]]) {
    const response = await session.send(`/callback/google?${new URLSearchParams({ state: value, code: 'code' })}`, { headers: { Cookie: cookies } });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('Location'), null);
  }
  assert.equal(calls, 0);
  await Promise.all([...session.pending, ...other.pending]);
});


// Two real OAuth sessions share one Worker, one KV store, and two synthetic
// LegendKeeper accounts. Only upstream HTTP is mocked; credentials and project
// discovery pass through the production Worker, MCP handler, and actual SDK.
test('strict two-user isolation across all three tools, refresh, concurrency and missing keys', async t => {
  const sharedValues = new Map();
  const nonces = new Map();
  const calls = [];
  const synthetic = {
    A: { key: 'synthetic-key-A', resource: 'resource-A', project: 'project-A', marker: 'PRIVATE_FIXTURE_A' },
    B: { key: 'synthetic-key-B', resource: 'resource-B', project: 'project-B', marker: 'PRIVATE_FIXTURE_B' },
  };
  const keys = { LEGENDKEEPER_API_KEY: synthetic.A.key, LEGENDKEEPER_API_KEY_HUSBAND: synthetic.B.key };
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (url.href === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'synthetic-github-token' });
    if (url.href === 'https://api.github.com/user') return Response.json({ id: 180304956 });
    if (url.href === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [publicJwk] });
    if (url.href === 'https://oauth2.googleapis.com/token') {
      assert.ok(nonces.has(options.body.get('code')));
      return Response.json({ id_token: await googleToken(nonces.get(options.body.get('code'))) });
    }
    assert.equal(url.origin, 'https://www.legendkeeper.com');
    assert.equal(options.method, 'GET', 'all LegendKeeper requests must be read-only');
    const account = Object.values(synthetic).find(account => options.headers.authorization === `Bearer ${account.key}`);
    assert.ok(account, 'only a configured server-side key may reach LegendKeeper');
    calls.push({ account: account.project, path: url.pathname, query: url.search });
    // Let both accounts overlap to catch accidentally shared SDK credentials
    // and project-resolution caches during Promise.all calls below.
    await new Promise(resolve => setImmediate(resolve));
    if (url.pathname.endsWith('/projects/')) return Response.json({ data: [{ id: account.project }], hasMore: false });
    const prefix = `/api/v3/projects/${account.project}/`;
    assert.ok(url.pathname.startsWith(prefix), 'SDK must discover the project using the selected identity key');
    const path = url.pathname.slice(prefix.length);
    if (path === 'search/') {
      const q = url.searchParams.get('q');
      const foreign = Object.values(synthetic).find(other => other !== account);
      const data = q === foreign.resource ? [] : [{ resource: { id: account.resource, name: account.marker }, document: { id: 'overview' } }];
      return Response.json({ data, hasMore: false });
    }
    if (path === 'resources/') {
      const cursor = url.searchParams.get('cursor');
      if (cursor && cursor !== `cursor-${account.project}`) return Response.json({ message: 'Foreign cursor rejected' }, { status: 400 });
      return Response.json({ data: [{ id: account.resource, name: account.marker }], hasMore: true, nextCursor: `cursor-${account.project}` });
    }
    if (path === `resources/${account.resource}/`) return Response.json({ id: account.resource, name: account.marker });
    if (path === `resources/${account.resource}/docs/`) return Response.json({ data: [{ id: 'overview', name: 'Overview', type: 'page' }], hasMore: false });
    if (path === `resources/${account.resource}/docs/overview/blocks/`) return Response.json({ id: 'overview', version: 'v1', schema: 1, blocks: [], text: account.marker });
    // A resource ID from the other account does not change credentials or
    // project. LegendKeeper's own authorization answers not found.
    return Response.json({ message: 'Resource not accessible' }, { status: 404 });
  });

  async function login(provider) {
    const session = await consentSession('https://chatgpt.com/connector_platform_oauth_redirect', { ...googleEnv, ...keys }, sharedValues);
    const approved = await session.post(session.handle, session.cookie, provider, ['mcp:read', 'offline_access']);
    assert.equal(approved.status, 302);
    const upstream = new URL(approved.headers.get('Location'));
    const code = `synthetic-code-${provider}`;
    nonces.set(code, upstream.searchParams.get('nonce'));
    const path = provider === 'google' ? '/callback/google' : '/callback';
    const callback = await session.send(`${path}?${new URLSearchParams({ state: upstream.searchParams.get('state'), code })}`, {
      headers: { Cookie: browserCookies(approved) },
    });
    assert.equal(callback.status, 302);
    const destination = new URL(callback.headers.get('Location'));
    assert.ok(destination.searchParams.get('code'));
    const tokenResponse = await session.send('/oauth/token', { method: 'POST', body: new URLSearchParams({
      grant_type: 'authorization_code', code: destination.searchParams.get('code'), client_id: session.client.clientId,
      code_verifier: session.verifier, redirect_uri: session.client.redirectUris[0], resource: `${production}/mcp`,
    }) });
    assert.equal(tokenResponse.status, 200);
    session.token = await tokenResponse.json();
    return session;
  }
  const sessions = { A: await login('github'), B: await login('google') };

  async function request(owner, name, args, { headers = {}, query = '', token = sessions[owner].token.access_token } = {}) {
    return sessions[owner].send(`/mcp${query}`, { method: 'POST', headers: {
      Host: new URL(production).host, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25', ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  }
  async function rpc(owner, name, args, options) {
    const response = await request(owner, name, args, options);
    assert.equal(response.status, 200);
    const body = await response.text();
    return JSON.parse(body.split('\n').find(line => line.startsWith('data:')).slice(5));
  }
  const inputs = owner => [
    ['search_campaign', { query: 'fixture' }],
    ['list_pages', { limit: 1 }],
    ['read_page', { resourceId: synthetic[owner].resource }],
  ];
  function onlyOwn(result, owner) {
    assert.notEqual(result.result.isError, true);
    assert.match(JSON.stringify(result), new RegExp(synthetic[owner].marker));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(synthetic[owner === 'A' ? 'B' : 'A'].marker));
    assert.doesNotMatch(JSON.stringify(result), /synthetic-key-/);
  }
  for (const owner of ['A', 'B']) {
    const other = owner === 'A' ? 'B' : 'A';
    for (const [name, args] of inputs(owner)) {
      await t.test(`${owner}: ${name} uses only its own account despite spoofed identity and credential hints`, async () => {
        const before = calls.length;
        const result = await rpc(owner, name, { ...args, identity: other === 'A' ? 'github:180304956' : 'google:husband-sub',
          provider: other === 'A' ? 'github' : 'google', email: 'other@example.invalid', userId: other,
          apiKey: synthetic[other].key, projectId: synthetic[other].project, resourceId: args.resourceId ?? synthetic[other].resource,
        }, { query: `?provider=${other === 'A' ? 'github' : 'google'}&apiKey=${synthetic[other].key}&projectId=${synthetic[other].project}`,
          headers: { 'X-User-Id': other, 'X-Identity': other === 'A' ? 'github:180304956' : 'google:husband-sub',
            'X-LegendKeeper-Api-Key': synthetic[other].key, 'X-Project-Id': synthetic[other].project } });
        onlyOwn(result, owner);
        assert.ok(calls.length > before);
        assert.ok(calls.slice(before).every(call => call.account === synthetic[owner].project));
      });
    }
    await t.test(`${owner}: foreign resource IDs, search queries, and cursors cannot cross accounts`, async () => {
      const before = calls.length;
      const read = await rpc(owner, 'read_page', { resourceId: synthetic[other].resource });
      assert.equal(read.result.isError, true);
      const search = await rpc(owner, 'search_campaign', { query: synthetic[other].resource });
      assert.deepEqual(JSON.parse(search.result.content[0].text).data, []);
      const list = await rpc(owner, 'list_pages', { cursor: `cursor-${synthetic[other].project}` });
      assert.equal(list.result.isError, true);
      for (const result of [read, search, list]) assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FIXTURE_|synthetic-key-/);
      assert.ok(calls.slice(before).every(call => call.account === synthetic[owner].project));
      assert.equal(calls.slice(before).some(call => call.path.includes(`/resources/${synthetic[other].resource}/docs`)), false);
    });
  }
  await t.test('concurrent users never share SDK credentials or project caches', async () => {
    for (let round = 0; round < 3; round++) {
      await Promise.all(['A', 'B'].flatMap(owner => inputs(owner).map(async ([name, args]) => onlyOwn(await rpc(owner, name, args), owner))));
    }
  });
  await t.test('refresh preserves each identity and its credential binding', async () => {
    for (const owner of ['A', 'B']) {
      const session = sessions[owner];
      const refreshed = await session.send('/oauth/token', { method: 'POST', body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: session.token.refresh_token,
        client_id: session.client.clientId, resource: `${production}/mcp`,
      }) });
      assert.equal(refreshed.status, 200);
      session.token = await refreshed.json();
      for (const [name, args] of inputs(owner)) onlyOwn(await rpc(owner, name, args), owner);
    }
  });
  for (const owner of ['A', 'B']) {
    await t.test(`${owner}: missing assigned key blocks all tools without fallback; other account remains usable`, async () => {
      const variable = owner === 'A' ? 'LEGENDKEEPER_API_KEY' : 'LEGENDKEEPER_API_KEY_HUSBAND';
      const other = owner === 'A' ? 'B' : 'A';
      const session = sessions[owner];
      const original = session.environment[variable];
      try {
        for (const missing of [undefined, '']) {
          session.environment[variable] = missing;
          for (const [name, args] of inputs(owner)) {
            const before = calls.length;
            const response = await request(owner, name, args);
            assert.equal(response.status, 503);
            assert.deepEqual(await response.json(), { error: 'Service configuration unavailable' });
            assert.equal(calls.length, before);
          }
        }
        for (const [name, args] of inputs(other)) onlyOwn(await rpc(other, name, args), other);
      } finally { session.environment[variable] = original; }
    });
    await t.test(`${owner}: invalid or missing bearer cannot use identity hints to access any tool`, async () => {
      for (const token of ['', 'forged-bearer']) {
        for (const [name, args] of inputs(owner)) {
          const before = calls.length;
          const response = await request(owner, name, { ...args, identity: owner }, { token, query: `?userId=${owner}`,
            headers: { 'X-LegendKeeper-Api-Key': synthetic[owner].key } });
          assert.equal(response.status, 401);
          assert.equal(calls.length, before);
        }
      }
    });
  }
  await Promise.all(Object.values(sessions).flatMap(session => session.pending));
});


test('write consent is explicit, optional and described separately from reads', async () => {
  for (const requested of [['mcp:read'], ['mcp:read', 'mcp:write']]) {
    const response = await handleOAuthRequest(new Request(`${production}/authorize`), { ...env,
      OAUTH_PROVIDER: { parseAuthRequest: async () => ({}),
        describeConsent: async () => ({ clientName: 'Test', redirectHost: 'client.example', scope: requested }),
        beginConsent: async () => ({ handle: 'test', headers: new Headers() }),
      } });
    const body = await response.text();
    assert.match(body, /value="mcp:read" checked required/);
    if (requested.includes('mcp:write')) {
      assert.match(body, /value="mcp:write">/);
      assert.match(body, /Create pages and edit or replace content and metadata/);
    } else assert.doesNotMatch(body, /value="mcp:write"/);
  }
});
