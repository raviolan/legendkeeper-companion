// Test-only entrypoint. Never configured as the deployed Worker.
import worker from '../../worker/index';
import { getOAuthApi } from '@cloudflare/workers-oauth-provider';

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/test/authorize') {
      const scopes = new URL(request.url).searchParams.has('write') ? ['mcp:read', 'mcp:write', 'offline_access'] : ['mcp:read', 'offline_access'];
      const api = getOAuthApi({
        apiRoute: '/mcp', apiHandler: { fetch: () => new Response() },
        defaultHandler: { fetch: () => new Response() },
        authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token',
        scopesSupported: ['mcp:read', 'mcp:write', 'offline_access'],
        resourceMetadata: { resource: `${env.MCP_BASE_URL}/mcp` },
      }, env);
      const client = await api.createClient({
        redirectUris: ['http://localhost:6274/callback'],
        tokenEndpointAuthMethod: 'none', grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'],
      });
      const verifier = 'a'.repeat(64);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const authRequest = await api.parseAuthRequest(new Request(`${env.MCP_BASE_URL}/authorize?` + new URLSearchParams({
        client_id: client.clientId, redirect_uri: client.redirectUris[0], response_type: 'code',
        scope: scopes.join(' '), resource: `${env.MCP_BASE_URL}/mcp`, code_challenge: challenge, code_challenge_method: 'S256',
      })));
      const { redirectTo } = await api.completeAuthorization({
        request: authRequest, userId: '123456', scope: scopes,
        props: { githubUserId: '123456' }, metadata: {},
      });
      return Response.json({ code: new URL(redirectTo).searchParams.get('code'), clientId: client.clientId, verifier });
    }
    return worker.fetch(request, env, ctx);
  },
};
