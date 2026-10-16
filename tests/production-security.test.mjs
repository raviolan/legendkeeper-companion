import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const production = 'https://legendkeeper-companion.pink-void.workers.dev';
const bundle = await build({
  stdin: { contents: "export {default as worker} from './worker/index'; export {handleOAuthRequest} from './worker/oauth';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'import'], external: ['node:*'],
  plugins: [{ name: 'cloudflare-test-entrypoint', setup(build) {
    build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export class WorkerEntrypoint {}' }));
  } }],
});
const { worker, handleOAuthRequest } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

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
async function consentSession(redirectUri = 'http://localhost:6274/callback') {
  const values = new Map();
  const testEnv = { ...env, OAUTH_KV: {
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
  const post = (formHandle = handle, browserCookie = cookie) => send('/authorize', {
    method: 'POST', headers: { Origin: 'null', 'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document',
      ...(browserCookie ? { Cookie: browserCookie } : {}) },
    body: new URLSearchParams({ handle: formHandle, decision: 'approve', scope: 'mcp:read' }),
  });
  return { send, post, handle, cookie, values, pending, consentResponse: response, html, client,
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
