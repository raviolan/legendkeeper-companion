import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeMcpContext, resolveMcpPrincipal } from '../src/remote-auth.mjs';

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


test('Google identity is namespaced and cannot collide with legacy GitHub grants', () => {
  const google = context({ githubUserId: undefined, allowedGoogleSub: '123456', identity: 'google:123456',
    auth: { userId: 'google/123456', audience: expectedAudience, scope: ['mcp:read'] } });
  assert.equal(authorizeMcpContext(google), null);
  for (const overrides of [{ identity: 'github:123456' }, { allowedGoogleSub: undefined },
    { allowedGoogleSub: 'other' }, { githubUserId: '123456' },
    { auth: { ...google.auth, userId: '123456' } }, { auth: { ...google.auth, audience: 'other' } }]) {
    assert.ok(authorizeMcpContext({ ...google, ...overrides }).status >= 400);
  }
  assert.equal(authorizeMcpContext({ ...google, auth: { ...google.auth, scope: [] } }).status, 403);
  assert.equal(authorizeMcpContext(context({ identity: 'github:123456' })), null);
  assert.equal(authorizeMcpContext(context({ identity: 'google:123456' })).status, 403);
});


test('credential principal is returned only after all identity, scope and audience checks', () => {
  assert.equal(resolveMcpPrincipal(context()), 'github'); // legacy production grant
  assert.equal(resolveMcpPrincipal(context({ identity: 'github:123456' })), 'github');
  const google = context({ githubUserId: undefined, allowedGoogleSub: '123456', identity: 'google:123456',
    auth: { userId: 'google/123456', audience: expectedAudience, scope: ['mcp:read'] } });
  assert.equal(resolveMcpPrincipal(google), 'google');
  for (const options of [context({ auth: undefined }), { ...google, identity: 'github:123456' },
    { ...google, auth: { ...google.auth, audience: 'other' } }, { ...google, auth: { ...google.auth, scope: [] } },
    { ...google, allowedGoogleSub: undefined }]) {
    assert.ok(resolveMcpPrincipal(options) instanceof Response);
  }
});
