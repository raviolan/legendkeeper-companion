import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeMcpContext } from '../src/remote-auth.mjs';

const expectedAudience = 'https://legendkeeper-companion.example.workers.dev/mcp';
function context(overrides = {}) {
  return {
    auth: { userId: '123456', audience: expectedAudience, scope: ['mcp:read'] },
    githubUserId: '123456',
    allowedGithubUserId: '123456',
    expectedAudience,
    insufficientScope: () => new Response('missing scope', { status: 403 }),
    ...overrides,
  };
}

test('allows only a token for the configured resource and GitHub identity with mcp:read', () => {
  assert.equal(authorizeMcpContext(context()), null);
  assert.equal(authorizeMcpContext(context({ allowedGithubUserId: '000123456' })), null);
});

test('rejects missing OAuth context before MCP tools can run', async () => {
  const response = authorizeMcpContext(context({ auth: undefined, githubUserId: undefined }));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'Unauthorized');
});

test('rejects an authenticated but non-allowlisted GitHub user', async () => {
  const response = authorizeMcpContext(context({
    auth: { userId: '987654', audience: expectedAudience, scope: ['mcp:read'] },
    githubUserId: '987654',
  }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'Forbidden');
});

test('rejects the wrong token audience', async () => {
  const response = authorizeMcpContext(context({ auth: { userId: '123456', audience: 'https://other.example/mcp', scope: ['mcp:read'] } }));
  assert.equal(response.status, 401);
});

test('requires mcp:read on every authenticated request', async () => {
  let scopes;
  const response = authorizeMcpContext(context({
    auth: { userId: '123456', audience: expectedAudience, scope: [] },
    insufficientScope: (_auth, required) => { scopes = required; return new Response('missing scope', { status: 403 }); },
  }));
  assert.equal(response.status, 403);
  assert.deepEqual(scopes, ['mcp:read']);
});
