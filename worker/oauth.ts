import {
  AuthorizationError,
  authorizationErrorRedirect,
  type ConsentDescription,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';
import { exchangeGoogleIdentity, googleConfigured, validGoogleSub } from './google';

export interface OAuthEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ALLOWED_GOOGLE_SUB?: string;
  GOOGLE_SUB_DISCOVERY?: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_GITHUB_USER_ID: string;
  MCP_BASE_URL: string;
  OAUTH_PROVIDER: OAuthHelpers;
}

interface UpstreamState {
  verifier: string;
  provider?: 'github' | 'google';
  nonce?: string;
}

const GRANTABLE_SCOPES = new Set(['mcp:read', 'mcp:write', 'offline_access']);
const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';

export async function handleOAuthRequest(request: Request, env: OAuthEnv): Promise<Response> {
  const url = new URL(request.url);

  try {
    if (url.pathname === '/authorize') {
      if (request.method === 'GET') return await showConsent(request, env);
      if (request.method === 'POST') return await submitConsent(request, env);
      return methodNotAllowed('GET, POST');
    }

    if (url.pathname === '/callback/google') {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      return await finishGoogleLogin(request, env);
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
  return new Response(renderConsent(details, consent.handle, googleConfigured(env)), { headers: consent.headers });
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

  const provider = String(form.get('provider') ?? 'github');
  if (provider !== 'github' && provider !== 'google') return page('Unknown identity provider.', 400);
  if (provider === 'google' && !googleConfigured(env)) return page('Google sign-in is not configured.', 503);

  const approved = await oauth.approveConsent(request, handle, { scope: selected });
  const verifier = randomVerifier();
  const nonce = provider === 'google' ? randomVerifier() : undefined;
  const upstream = await oauth.beginUpstream(approved.request, {
    data: { verifier, provider, nonce },
    headers: approved.headers,
  });

  if (provider === 'google') {
    const google = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    google.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      redirect_uri: `${canonicalBase(env.MCP_BASE_URL)}/callback/google`,
      response_type: 'code', scope: 'openid', prompt: 'select_account',
      state: upstream.state, nonce: nonce!,
      code_challenge: await s256(verifier), code_challenge_method: 'S256',
    }).toString();
    upstream.headers.set('Location', google.toString());
    return new Response(null, { status: 302, headers: upstream.headers });
  }

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
  // Absent provider is accepted only for pre-upgrade GitHub transactions.
  if (upstream.data.provider && upstream.data.provider !== 'github') return page('Invalid identity provider callback.', 400);
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
    props: { githubUserId, identity: `github:${githubUserId}` },
  });
  upstream.headers.set('Location', completed.redirectTo);
  return new Response(null, { status: 302, headers: upstream.headers });
}

async function finishGoogleLogin(request: Request, env: OAuthEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const upstream = await oauth.finishUpstream<UpstreamState>(request);
  if (upstream.data.provider !== 'google' || !upstream.data.nonce || !googleConfigured(env)) {
    return page('Invalid identity provider callback.', 400);
  }
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  let sub: string | null = null;
  if (code && !url.searchParams.has('error')) {
    // Never log tokens, claims, authorization codes, or upstream error bodies.
    try { sub = await exchangeGoogleIdentity(code, upstream.data.verifier, upstream.data.nonce, env); }
    catch { /* Fail closed; return the validated client's access_denied redirect. */ }
  }
  // Local-only bootstrap: display the verified subject, without issuing any grant.
  // Requires an explicit local flag and an unset allowlist; never active in production.
  if (sub && isLocalDiscovery(env)) {
    const response = page(`Verified Google sub: ${sub}. No MCP access was granted. Set ALLOWED_GOOGLE_SUB to this exact value and disable GOOGLE_SUB_DISCOVERY.`, 200);
    for (const cookie of upstream.headers.getSetCookie()) response.headers.append('Set-Cookie', cookie);
    return response;
  }
  if (!sub || !validGoogleSub(env.ALLOWED_GOOGLE_SUB) || sub !== env.ALLOWED_GOOGLE_SUB) {
    upstream.headers.set('Location', authorizationErrorRedirect(upstream.request, 'access_denied'));
    return new Response(null, { status: 302, headers: upstream.headers });
  }
  const identity = `google:${sub}`;
  const completed = await oauth.completeAuthorization({
    // The SDK forbids colons in userId; the encrypted identity prop uses google:sub.
    request: upstream.request, userId: `google/${encodeURIComponent(sub)}`, metadata: {},
    scope: upstream.request.scope.filter(scope => GRANTABLE_SCOPES.has(scope)),
    props: { identity },
  });
  upstream.headers.set('Location', completed.redirectTo);
  return new Response(null, { status: 302, headers: upstream.headers });
}

function isLocalDiscovery(env: OAuthEnv): boolean {
  const host = new URL(canonicalBase(env.MCP_BASE_URL)).hostname;
  return ['localhost', '127.0.0.1', '[::1]'].includes(host)
    && env.GOOGLE_SUB_DISCOVERY === 'true' && !env.ALLOWED_GOOGLE_SUB;
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

function renderConsent(details: ConsentDescription, handle: string, googleEnabled: boolean): string {
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
    return `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}"${checked}> ${escapeHtml(scope)} — ${scope === 'mcp:write' ? 'Create pages and edit or replace content and metadata' : scope === 'mcp:read' ? 'Search and read campaign content' : 'Maintain access using refresh tokens'}${scope === 'mcp:read' ? ' (required)' : ''}</label>`;
  }).join('<br>');

  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${name}</title>
<main><h1>Allow ${name} to access LegendKeeper?</h1>
<p>${clientIdentity}</p>
<p>The MCP client will receive access to LegendKeeper tools with the permissions selected below. Its redirect destination is <strong>${redirectHost}</strong>.</p>
${loopbackWarning}
<p>Your selected provider will verify your account. Only the configured accounts can access the tools.</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
${scopeRows}
<p><label>Sign in with <select name="provider"><option value="github">GitHub</option>${googleEnabled ? '<option value="google">Google</option>' : ''}</select></label></p>
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
