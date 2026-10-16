import {
  AuthorizationError,
  authorizationErrorRedirect,
  type ConsentDescription,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';

export interface OAuthEnv {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_GITHUB_USER_ID: string;
  MCP_BASE_URL: string;
  OAUTH_PROVIDER: OAuthHelpers;
}

interface UpstreamState {
  verifier: string;
}

const GRANTABLE_SCOPES = new Set(['mcp:read', 'offline_access']);
const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';

export async function handleOAuthRequest(request: Request, env: OAuthEnv): Promise<Response> {
  const url = new URL(request.url);

  try {
    if (url.pathname === '/authorize') {
      if (request.method === 'GET') return await showConsent(request, env);
      if (request.method === 'POST') return await submitConsent(request, env);
      return methodNotAllowed('GET, POST');
    }

    if (url.pathname === '/callback') {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      return await finishGithubLogin(request, env);
    }

    return new Response('Not found', { status: 404 });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError) {
      return page('Authorization could not be started. Return to your MCP client and try again.', 400);
    }
    // Keep upstream, KV, and OAuth diagnostics out of browser responses and logs.
    return page('Authorization is temporarily unavailable. Please return to your MCP client and try again.', 503);
  }
}

async function showConsent(request: Request, env: OAuthEnv): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !/^\d{1,20}$/.test(env.ALLOWED_GITHUB_USER_ID)) {
    return page('Authorization is not configured. Please return to your MCP client.', 503);
  }
  const oauth = env.OAUTH_PROVIDER;
  const authorization = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authorization);
  const consent = await oauth.beginConsent(authorization);
  consent.headers.set('Content-Type', 'text/html; charset=utf-8');
  applyConsentSecurityHeaders(consent.headers);
  return new Response(renderConsent(details, consent.handle), { headers: consent.headers });
}

async function submitConsent(request: Request, env: OAuthEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get('handle') ?? '');
  if (!handle) return page('This authorization form has expired. Start again from your MCP client.', 400);

  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  const selected = [...new Set(form.getAll('scope').map(String))]
    .filter((scope) => GRANTABLE_SCOPES.has(scope));
  if (!selected.includes('mcp:read')) {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  const approved = await oauth.approveConsent(request, handle, { scope: selected });
  const verifier = randomVerifier();
  const upstream = await oauth.beginUpstream(approved.request, {
    data: { verifier },
    headers: approved.headers,
  });

  const callback = `${canonicalBase(env.MCP_BASE_URL)}/callback`;
  const github = new URL(GITHUB_AUTHORIZE_URL);
  github.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  github.searchParams.set('redirect_uri', callback);
  github.searchParams.set('state', upstream.state);
  github.searchParams.set('code_challenge', await s256(verifier));
  github.searchParams.set('code_challenge_method', 'S256');
  github.searchParams.set('scope', 'read:user');
  github.searchParams.set('allow_signup', 'false');

  upstream.headers.set('Location', github.toString());
  return new Response(null, { status: 302, headers: upstream.headers });
}

async function finishGithubLogin(request: Request, env: OAuthEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const upstream = await oauth.finishUpstream<UpstreamState>(request);
  const callbackUrl = new URL(request.url);

  if (callbackUrl.searchParams.has('error')) {
    upstream.headers.set('Location', authorizationErrorRedirect(upstream.request, 'access_denied'));
    return new Response(null, { status: 302, headers: upstream.headers });
  }

  const code = callbackUrl.searchParams.get('code');
  if (!code) {
    upstream.headers.set('Location', authorizationErrorRedirect(upstream.request, 'access_denied'));
    return new Response(null, { status: 302, headers: upstream.headers });
  }

  const githubUserId = await exchangeAndIdentify(code, upstream.data.verifier, env);
  if (!githubUserId || !isAllowedGithubUser(githubUserId, env.ALLOWED_GITHUB_USER_ID)) {
    upstream.headers.set('Location', authorizationErrorRedirect(upstream.request, 'access_denied'));
    return new Response(null, { status: 302, headers: upstream.headers });
  }

  const completed = await oauth.completeAuthorization({
    request: upstream.request,
    userId: githubUserId,
    metadata: {},
    scope: upstream.request.scope.filter((scope) => GRANTABLE_SCOPES.has(scope)),
    props: { githubUserId },
  });
  upstream.headers.set('Location', completed.redirectTo);
  return new Response(null, { status: 302, headers: upstream.headers });
}

async function exchangeAndIdentify(code: string, verifier: string, env: OAuthEnv): Promise<string | null> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return null;

  const callback = `${canonicalBase(env.MCP_BASE_URL)}/callback`;
  const body = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    client_secret: env.GITHUB_CLIENT_SECRET,
    code,
    code_verifier: verifier,
    redirect_uri: callback,
  });

  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenResponse.ok) return null;

  const tokenData: unknown = await tokenResponse.json().catch(() => null);
  if (!isRecord(tokenData) || typeof tokenData.access_token !== 'string' || tokenData.error) return null;
  const githubToken = tokenData.access_token;

  const userResponse = await fetch('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken}`,
      'User-Agent': 'legendkeeper-companion',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!userResponse.ok) return null;

  const userData: unknown = await userResponse.json().catch(() => null);
  if (!isRecord(userData) || !Number.isSafeInteger(userData.id) || Number(userData.id) < 1) return null;
  return String(userData.id);
}

function renderConsent(details: ConsentDescription, handle: string): string {
  const name = escapeHtml(details.clientName);
  const redirectHost = escapeHtml(details.redirectHost);
  const clientIdentity = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : 'This client registered itself; its name is not verified.';
  const loopbackWarning = details.redirectIsLoopback
    ? '<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>'
    : '';
  const availableScopes = [...new Set([...details.scope, 'mcp:read'])]
    .filter((scope) => GRANTABLE_SCOPES.has(scope));
  const scopeRows = availableScopes.map((scope) => {
    const checked = scope === 'mcp:read' ? ' checked required' : '';
    return `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}"${checked}> ${escapeHtml(scope)}${scope === 'mcp:read' ? ' (required)' : ''}</label>`;
  }).join('<br>');

  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${name}</title>
<main><h1>Allow ${name} to access LegendKeeper?</h1>
<p>${clientIdentity}</p>
<p>The MCP client will receive access to the read-only LegendKeeper tools. Its redirect destination is <strong>${redirectHost}</strong>.</p>
${loopbackWarning}
<p>GitHub will verify that you are the allowed account. The GitHub token is used only to check your account identity.</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
${scopeRows}
<p><button type="submit" name="decision" value="approve">Allow</button>
<button type="submit" name="decision" value="deny" formnovalidate>Deny</button></p>
</form></main></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function randomVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64Url(bytes);
}

async function s256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function isAllowedGithubUser(actual: string, expected: string): boolean {
  return /^\d{1,20}$/.test(expected) && actual === expected.replace(/^0+(?=\d)/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function canonicalBase(value: string): string {
  const url = new URL(value);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('Invalid MCP base URL');
  }
  return url.origin;
}

function methodNotAllowed(allow: string): Response {
  return new Response('Method not allowed', { status: 405, headers: { Allow: allow } });
}

function applyConsentSecurityHeaders(headers: Headers): void {
  headers.set('Cache-Control', 'no-store');
  // Match the provider's consent pattern: keep anti-framing, but no form-action.
  // Chrome can apply it to the entire redirect chain, including a dynamically
  // registered client's validated callback. default-src does NOT restrict forms.
  // Fixed form action, escaped metadata and provider CSRF/redirect validation
  // remain required; omitting form-action gives up form-exfiltration defense.
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
}

function page(message: string, status: number): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Authorization</title><p>${escapeHtml(message)}</p>`, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
