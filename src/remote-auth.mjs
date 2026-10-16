/**
 * Defense-in-depth policy check used only after OAuthProvider validates the
 * bearer token. Returning null allows the request to reach the MCP handler.
 */
export function authorizeMcpContext({ auth, githubUserId, allowedGithubUserId, expectedAudience, insufficientScope }) {
  if (!auth || typeof githubUserId !== 'string') {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }

  const allowed = normalizeNumericId(allowedGithubUserId);
  if (!allowed || auth.userId !== allowed || normalizeNumericId(githubUserId) !== allowed) {
    return Response.json({ error: 'Forbidden' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  if (auth.audience !== expectedAudience) {
    return Response.json({ error: 'Invalid token audience' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  if (!Array.isArray(auth.scope) || !auth.scope.includes('mcp:read')) {
    return insufficientScope(auth, ['mcp:read']);
  }
  return null;
}

function normalizeNumericId(value) {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) return null;
  return value.replace(/^0+(?=\d)/, '');
}
