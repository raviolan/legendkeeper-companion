import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { OAuthEnv } from './oauth';

// Fixed trusted endpoints: token-controlled jku/x5u URLs are never followed.
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), {
  timeoutDuration: 10_000,
});

export function validGoogleSub(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,255}$/.test(value);
}

export function googleConfigured(env: OAuthEnv): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export async function verifyGoogleIdToken(token: string, audience: string, nonce: string,
  keys: JWTVerifyGetKey = googleKeys): Promise<string> {
  if (!audience || !nonce) throw new Error('Missing Google validation context');
  const { payload } = await jwtVerify(token, keys, {
    algorithms: ['RS256'], issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience, requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub', 'nonce'],
  });
  if (payload.nonce !== nonce || !validGoogleSub(payload.sub)
    || (payload.azp !== undefined && payload.azp !== audience)
    || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== audience)
    || typeof payload.iat !== 'number' || payload.iat > Math.floor(Date.now() / 1000) + 60) {
    throw new Error('Invalid Google identity claims');
  }
  return payload.sub;
}

export async function exchangeGoogleIdentity(code: string, verifier: string, nonce: string,
  env: OAuthEnv): Promise<string | null> {
  if (!googleConfigured(env)) return null;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code,
      client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${new URL(env.MCP_BASE_URL).origin}/callback/google`, code_verifier: verifier }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || !('id_token' in data) || typeof data.id_token !== 'string') return null;
  return verifyGoogleIdToken(data.id_token, env.GOOGLE_CLIENT_ID!, nonce);
}
