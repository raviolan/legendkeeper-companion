/**
 * Defense-in-depth policy check used only after OAuthProvider validates the
 * bearer token. Returning null allows the request to reach the MCP handler.
 */
export function authorizeMcpContext(options) {
  const principal = resolveMcpPrincipal(options);
  return principal instanceof Response ? principal : null;
}

/**
 * Resolve a principal only after identity, allowlist, audience, and scope agree.
 * Callers pass the OAuthProvider context, never request parameters or headers.
 * No credentials are read until this function succeeds.
 */
export function resolveMcpPrincipal({ auth, githubUserId, identity, allowedGoogleSub, allowedGithubUserId, expectedAudience, insufficientScope }) {
  if (!auth || (typeof githubUserId !== 'string' && typeof identity !== 'string')) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }

  const allowed = normalizeNumericId(allowedGithubUserId);
  // Legacy numeric GitHub grants remain valid. Google always has a namespace;
  // the identity prop and provider-validated userId must agree exactly.
  const githubAllowed = allowed && auth.userId === allowed && normalizeNumericId(githubUserId) === allowed
    && (identity === undefined || identity === `github:${allowed}`);
  const googleAllowed = typeof allowedGoogleSub === 'string' && /^[\x21-\x7e]{1,255}$/.test(allowedGoogleSub)
    && identity === `google:${allowedGoogleSub}` && auth.userId === `google/${encodeURIComponent(allowedGoogleSub)}` && githubUserId === undefined;
  if (!githubAllowed && !googleAllowed) {
    return Response.json({ error: 'Forbidden' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  if (auth.audience !== expectedAudience) {
    return Response.json({ error: 'Invalid token audience' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  if (!Array.isArray(auth.scope) || !auth.scope.includes('mcp:read')) {
    return insufficientScope(auth, ['mcp:read']);
  }
  return githubAllowed ? 'github' : 'google';
}

function normalizeNumericId(value) {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) return null;
  return value.replace(/^0+(?=\d)/, '');
}
