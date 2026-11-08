import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';


// Exercise the bundled Worker and real OAuth/MCP libraries with in-memory KV.
// Cloudflare WorkerEntrypoint is stubbed; no listening socket or credentials are needed.
// Only the GitHub identity/consent step is replaced by a test-only authorization fixture.
for (const base of ['http://localhost:8787', 'https://legendkeeper-companion.pink-void.workers.dev']) {
test(`authenticated Inspector initialization and tools/list support 2025-11-25 at ${base}`, async (t) => {
  const bundle = await build({ entryPoints: ['tests/fixtures/mcp-worker.ts'], bundle: true,
    mainFields: ['module', 'main'], write: false, format: 'esm', platform: 'neutral', conditions: ['workerd', 'worker', 'import'],
    external: ['node:*'], plugins: [{ name: 'cloudflare-entrypoint', setup(build) {
      build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export class WorkerEntrypoint {}' }));
    } }] });
  const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const values = new Map();
  const env = { MCP_BASE_URL: base, MCP_CORS_ORIGIN: 'http://127.0.0.1:6274,http://localhost:6274', ALLOWED_GITHUB_USER_ID: '123456',
    LEGENDKEEPER_API_KEY: 'test-unused-key', OAUTH_KV: {
      async get(key, options) { const value = values.get(key) ?? null; return value && (options === 'json' || options?.type === 'json') ? JSON.parse(value) : value; },
      async put(key, value) { values.set(key, value); },
      async delete(key) { values.delete(key); },
      async list({ prefix = '' } = {}) { return { keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })), list_complete: true }; },
    } };
  const pending = [];
  try {
    const send = (path, init) => worker.fetch(new Request(`${base}${path}`, init), env, { waitUntil(promise) { pending.push(promise); } });
    const unauth = await send('/mcp', { method: 'POST' });
    assert.equal(unauth.status, 401);
    const auth = await (await send('/test/authorize')).json();
    const exchange = await send('/oauth/token', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: auth.code,
        client_id: auth.clientId, code_verifier: auth.verifier,
        redirect_uri: 'http://localhost:6274/callback', resource: `${base}/mcp` }).toString() });
    assert.equal(exchange.status, 200, await exchange.clone().text());
    const issued = await exchange.json();
    assert.ok(issued.refresh_token);
    const refreshed = await send('/oauth/token', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: issued.refresh_token,
        client_id: auth.clientId, resource: `${base}/mcp` }).toString() });
    assert.equal(refreshed.status, 200, await refreshed.clone().text());
    const renewed = await refreshed.json();
    assert.ok(renewed.refresh_token);
    assert.notEqual(renewed.refresh_token, issued.refresh_token);
    const { access_token } = renewed;
    assert.ok(access_token);
    for (const origin of env.MCP_CORS_ORIGIN.split(',')) {
      const requestHeaders = { Origin: origin, 'Content-Type': 'application/json' };
      const unauthorized = await send('/mcp', { method: 'POST', headers: requestHeaders });
      assert.equal(unauthorized.status, 401);
      const preflight = await send('/mcp', { method: 'OPTIONS', headers: {
        Origin: origin, 'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,mcp-protocol-version',
      } });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
      const response = await rpc({ jsonrpc: '2.0', id: 10, method: 'initialize', params: {
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'inspector', version: '2.11.0' },
      } }, '2025-11-25', origin);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
      assert.match(response.headers.get('Vary'), /Origin/);
      const initialized = await result(response);
      assert.equal(initialized.result.protocolVersion, '2025-11-25');
      const tools = await result(await rpc({ jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} }, '2025-11-25', origin));
      assert.equal(tools.result.tools.length, 9);
    }
    for (const origin of ['https://evil.example', 'http://localhost:6275', 'https://localhost:6274']) {
      const response = await rpc({ jsonrpc: '2.0', id: 12, method: 'tools/list' }, '2025-11-25', origin);
      assert.equal(response.status, 403);
      assert.equal(await response.text(), 'Origin not allowed');
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    }

    async function rpc(message, version = '2025-11-25', origin) {
      return send('/mcp', { method: 'POST', headers: {
        ...(version === '2026-07-28' ? { 'Mcp-Method': message.method } : {}), ...(origin ? { Origin: origin } : {}), Host: new URL(base).host, Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': version,
      }, body: JSON.stringify(message) });
    }
    async function result(response) {
      const body = await response.text();
      assert.equal(response.status, 200, body);
      return response.headers.get('content-type').includes('text/event-stream')
        ? JSON.parse(body.split('\n').find(line => line.startsWith('data:')).slice(5)) : JSON.parse(body);
    }
    const initialized = await result(await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'inspector-regression', version: '2.11.0' } } }));
    assert.equal(initialized.result.protocolVersion, '2025-11-25');
    assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const listed = await result(await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
    assert.deepEqual(listed.result.tools.map(tool => tool.name).sort(), ['append_page', 'create_page', 'edit_page_block', 'list_pages', 'read_document_blocks', 'read_page', 'replace_page_content', 'search_campaign', 'update_resource']);
    assert.ok(listed.result.tools.filter(tool => ['list_pages', 'read_page', 'search_campaign', 'read_document_blocks'].includes(tool.name)).every(tool => tool.annotations.readOnlyHint));
    const modern = await result(await rpc({ jsonrpc: '2.0', id: 3, method: 'server/discover',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'regression', version: '1' } } } }, '2026-07-28'));
    assert.ok(modern.result);

    // Emulate workerd's receiver requirement while exercising the real SDK,
    // project auto-discovery, bearer authentication, and authenticated tools/call.
    const paths = [];
    t.mock.method(globalThis, 'fetch', async function (input, init) {
      assert.equal(this, globalThis, 'Worker fetch requires its global receiver');
      const url = new URL(input);
      assert.equal(url.origin, 'https://www.legendkeeper.com');
      assert.equal(init.headers.authorization, 'Bearer test-unused-key');
      assert.equal(init.method, 'GET');
      paths.push(url.pathname);
      if (url.pathname.endsWith('/projects/')) {
        return Response.json({ data: [{ id: 'project-1' }], hasMore: false });
      }
      if (url.pathname.endsWith('/resources/character-1/')) {
        return Response.json({ id: 'character-1', name: 'Character' });
      }
      if (url.pathname.endsWith('/resources/character-1/docs/')) {
        return Response.json({ data: [{ id: 'overview', name: 'Overview', type: 'page' }], hasMore: false });
      }
      if (url.pathname.endsWith('/docs/overview/blocks/')) {
        return Response.json({ id: 'overview', version: 'v1', schema: 1, blocks: [], text: 'Biography fixture.' });
      }
      assert.match(url.pathname, /projects\/project-1\/resources\/$/);
      assert.equal(url.searchParams.get('limit'), '1');
      return Response.json({ data: [{ id: 'page-1', name: 'Test page' }], hasMore: false });
    });
    const read = await result(await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'list_pages', arguments: { limit: 1 } } }));
    assert.notEqual(read.result.isError, true);
    assert.equal(JSON.parse(read.result.content[0].text).data[0].id, 'page-1');
    assert.equal(paths.length, 2);
    const profile = await result(await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'read_page', arguments: { resourceId: 'character-1' } } }));
    assert.notEqual(profile.result.isError, true);
    assert.equal(JSON.parse(profile.result.content[0].text).documents[0].text, 'Biography fixture.');
    assert.equal(paths.length, 6); // fresh SDK: project, resource, document list, blocks

    // A real read-only provider token must fail every write before SDK access.
    const beforeWrites = paths.length;
    for (const [name, args] of [
      ['append_page', { resourceId: 'r', documentId: 'd', expectedVersion: 'v1', content: 'X' }],
      ['edit_page_block', { resourceId: 'r', documentId: 'd', expectedVersion: 'v1', blockId: 'b', content: 'X' }],
      ['replace_page_content', { resourceId: 'r', documentId: 'd', expectedVersion: 'v1', content: 'X', mode: 'replace_entire_document' }],
      ['create_page', { name: 'X' }], ['update_resource', { resourceId: 'r', name: 'X' }],
    ]) {
      const denied = await result(await rpc({ jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name, arguments: args } }));
      assert.equal(denied.result.isError, true);
      assert.match(denied.result.content[0].text, /mcp:write/);
    }
    assert.equal(paths.length, beforeWrites);
    const writeAuth = await (await send('/test/authorize?write=1')).json();
    const writeExchange = await send('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: writeAuth.code, client_id: writeAuth.clientId,
        code_verifier: writeAuth.verifier, redirect_uri: 'http://localhost:6274/callback', resource: `${base}/mcp` }).toString() });
    assert.equal(writeExchange.status, 200);
    const writeToken = (await writeExchange.json()).access_token;
    t.mock.method(globalThis, 'fetch', async function (input, init) {
      const path = new URL(input).pathname;
      if (path.endsWith('/projects/')) return Response.json({ data: [{ id: 'project-1' }] });
      assert.equal(init.method, 'POST');
      assert.match(path, /resources\/$/);
      return Response.json({ id: 'new-npc', name: 'New NPC', documents: [] });
    });
    const createdResponse = await send('/mcp', { method: 'POST', headers: { Host: new URL(base).host, Authorization: `Bearer ${writeToken}`,
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 50, method: 'tools/call', params: { name: 'create_page', arguments: { name: 'New NPC' } } }) });
    const created = await result(createdResponse);
    assert.notEqual(created.result.isError, true);
    assert.equal(JSON.parse(created.result.content[0].text).resource.id, 'new-npc');

    const logs = [];
    env.MCP_DEV_DIAGNOSTICS = 'true';
    t.mock.method(console, 'error', line => logs.push(JSON.parse(line)));
    t.mock.method(globalThis, 'fetch', async function () {
      assert.equal(this, globalThis);
      return Response.json({ message: 'private campaign test-unused-key' }, { status: 401 });
    });
    const rejected = await result(await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'list_pages', arguments: { limit: 1 } } }));
    assert.equal(rejected.result.isError, true);
    if (base.startsWith('http:')) {
      assert.equal(logs[0].errorType, 'AuthenticationError');
      assert.equal(logs[0].status, 401);
      assert.equal(logs[0].apiKeyBindingExists, true);
    } else assert.deepEqual(logs, []);
    assert.doesNotMatch(JSON.stringify([logs, rejected]), /private campaign|test-unused-key/);

  } finally { await Promise.all(pending); }
});

}
