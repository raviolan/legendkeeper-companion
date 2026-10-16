import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpPreflight, isAllowedRequestOrigin } from '../src/remote-origin.mjs';

const base = 'https://legendkeeper-companion.example.workers.dev';
const client = 'https://chatgpt.com';

test('allows origin-less MCP clients and only configured browser origins', () => {
  assert.equal(isAllowedRequestOrigin(new Request(`${base}/mcp`), base), true);
  assert.equal(isAllowedRequestOrigin(new Request(`${base}/mcp`, { headers: { Origin: client } }), base, client), true);
  assert.equal(isAllowedRequestOrigin(new Request(`${base}/mcp`, { headers: { Origin: 'https://attacker.example' } }), base, client), false);
});

test('preflight returns exact-origin CORS headers for MCP authorization requests', async () => {
  const request = new Request(`${base}/mcp`, {
    method: 'OPTIONS',
    headers: { Origin: client, 'Access-Control-Request-Headers': 'authorization, content-type, mcp-protocol-version' },
  });
  const response = handleMcpPreflight(request, base, client);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), client);
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
});

test('rejects disallowed origins and unexpected preflight headers', () => {
  const blocked = handleMcpPreflight(new Request(`${base}/mcp`, { method: 'OPTIONS', headers: { Origin: 'https://attacker.example' } }), base, client);
  const headers = handleMcpPreflight(new Request(`${base}/mcp`, {
    method: 'OPTIONS', headers: { Origin: client, 'Access-Control-Request-Headers': 'authorization, x-unexpected' },
  }), base, client);
  assert.equal(blocked.status, 403);
  assert.equal(headers.status, 403);
});

const inspectorOrigins = 'http://127.0.0.1:6274,http://localhost:6274';
test('explicit Inspector origins receive only their own CORS origin', () => {
  for (const origin of inspectorOrigins.split(',')) {
    const request = new Request(`${base}/mcp`, { method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,mcp-protocol-version,mcp-method,mcp-name',
    } });
    assert.equal(isAllowedRequestOrigin(request, base, inspectorOrigins), true);
    const response = handleMcpPreflight(request, base, inspectorOrigins);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(response.headers.get('Vary'), 'Origin');
  }
});

test('Inspector hostname authorization never permits different schemes, ports, subdomains, or malformed Origins', () => {
  for (const origin of ['https://localhost:6274', 'http://localhost:6275', 'http://127.0.0.1:1234',
    'http://localhost.evil.example:6274', 'https://evil.example', 'null', '',
    'http://localhost:6274/path', 'http://user:password@localhost:6274', 'http://localhost:6274?secret=value']) {
    const request = new Request(`${base}/mcp`, { method: 'OPTIONS', headers: { Origin: origin } });
    assert.equal(isAllowedRequestOrigin(request, base, inspectorOrigins), false, origin);
    assert.equal(handleMcpPreflight(request, base, inspectorOrigins).status, 403, origin);
  }
  for (const configured of ['*', 'http://localhost:6274,*', 'https://example.com/path']) {
    assert.throws(() => isAllowedRequestOrigin(new Request(`${base}/mcp`), base, configured), /MCP_CORS_ORIGIN/);
  }
});

test('unconfigured Inspector origins are rejected and non-read preflights remain rejected', () => {
  assert.equal(isAllowedRequestOrigin(new Request(`${base}/mcp`, { headers: { Origin: 'http://localhost:6274' } }), base), false);
  const request = new Request(`${base}/mcp`, { method: 'OPTIONS', headers: {
    Origin: 'http://localhost:6274', 'Access-Control-Request-Method': 'DELETE',
  } });
  assert.equal(handleMcpPreflight(request, base, inspectorOrigins).status, 403);
});
