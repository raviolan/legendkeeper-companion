import { developmentReadDiagnostics } from '../src/legendkeeper-diagnostics.mjs';
import { LegendKeeper } from '@legendkeeper/sdk';
import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { insufficientScope, OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { registerLegendKeeperTools } from '../src/legendkeeper-tools.mjs';
import { authorizeMcpContext } from '../src/remote-auth.mjs';
import { handleMcpPreflight, isAllowedRequestOrigin, mcpCorsOptions, mcpOriginHostnames } from '../src/remote-origin.mjs';
import { handleOAuthRequest, type OAuthEnv } from './oauth';

interface Env extends OAuthEnv {
  LEGENDKEEPER_API_KEY: string;
  OAUTH_KV: KVNamespace;
  MCP_CORS_ORIGIN?: string;
  MCP_DEV_DIAGNOSTICS?: string;
}

interface AuthContext {
  audience: string;
  scope: string[];
  userId: string;
}

interface ApiContext extends ExecutionContext {
  auth: AuthContext;
  props: { githubUserId?: string };
}

export default {
  fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const base = canonicalBase(env.MCP_BASE_URL);
    const requestUrl = new URL(request.url);

    // Keep discovery, redirects, and protected-resource identifiers on one
    // canonical origin. Production requires HTTPS; localhost is allowed for dev.
    if (requestUrl.origin !== base.origin || requestUrl.pathname.startsWith('//')) {
      return Promise.resolve(new Response('Misdirected request', { status: 421 }));
    }
    if (base.protocol !== 'https:' && !isLocalhost(base.hostname)) {
      return Promise.resolve(new Response('HTTPS is required', { status: 400 }));
    }
    // MCP browser requests use exact Origin validation. OAuth browser routes
    // use the provider's consent handle/cookie and upstream-state protections;
    // valid form navigations can carry an opaque (null) Origin.
    const isMcpRoute = requestUrl.pathname === '/mcp' || requestUrl.pathname.startsWith('/mcp/');
    if (isMcpRoute && !isAllowedRequestOrigin(request, base.origin, env.MCP_CORS_ORIGIN)) {
      return Promise.resolve(new Response('Origin not allowed', { status: 403, headers: { 'Cache-Control': 'no-store', Vary: 'Origin' } }));
    }
    if (request.method === 'OPTIONS' && requestUrl.pathname === '/mcp') {
      return Promise.resolve(handleMcpPreflight(request, base.origin, env.MCP_CORS_ORIGIN));
    }

    const apiHandler = {
      async fetch(apiRequest: Request, apiEnv: Env, apiContext: ExecutionContext): Promise<Response> {
        const authContext = apiContext as ApiContext;
        const auth = authContext.auth;

        // OAuthProvider rejects missing/invalid tokens before this handler.
        // Keep an explicit guard so no future routing change can expose data.
        const accessDenied = authorizeMcpContext({
          auth,
          githubUserId: authContext.props?.githubUserId,
          allowedGithubUserId: apiEnv.ALLOWED_GITHUB_USER_ID,
          expectedAudience: `${base.origin}/mcp`,
          insufficientScope,
        });
        if (accessDenied) return accessDenied;
        const onReadError = developmentReadDiagnostics(apiEnv, base.hostname);
        if (!apiEnv.LEGENDKEEPER_API_KEY) {
          onReadError('configuration', new Error());
          return Response.json({ error: 'Service configuration unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
        }

        const server = createMcpHandler(() => {
          const mcp = new McpServer({ name: 'legendkeeper-companion', version: '1.0.0' });
          const lk = new LegendKeeper({
            apiKey: apiEnv.LEGENDKEEPER_API_KEY,
            // SDK 4.1 calls config.fetch(...); preserve the Worker global receiver.
            fetch: (input, init) => globalThis.fetch(input, init),
          });
          registerLegendKeeperTools(mcp, lk, { onReadError });
          return mcp;
        }, {
          route: '/mcp',
          // Official stateless compatibility for Inspector's 2025-11-25 protocol.
          legacy: 'stateless',
          allowedHostnames: [base.hostname],
          allowedOriginHostnames: mcpOriginHostnames(base.hostname, apiEnv.MCP_CORS_ORIGIN),
          corsOptions: mcpCorsOptions(apiRequest, base.origin, apiEnv.MCP_CORS_ORIGIN),
          onerror: () => undefined,
        });
        const response = await server(apiRequest, apiEnv, apiContext);
        // CORS varies by requesting origin when several exact origins are configured.
        const headers = new Headers(response.headers);
        const vary = headers.get('Vary');
        if (!vary?.split(',').some(value => value.trim().toLowerCase() === 'origin')) {
          headers.set('Vary', vary ? `${vary}, Origin` : 'Origin');
        }
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      },
    };

    const provider = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler,
      defaultHandler: {
        fetch: (oauthRequest: Request, oauthEnv: Env) => handleOAuthRequest(oauthRequest, oauthEnv),
      },
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/register',
      scopesSupported: ['mcp:read', 'offline_access'],
      resourceMetadata: {
        resource: `${base.origin}/mcp`,
        authorization_servers: [base.origin],
        resource_name: 'LegendKeeper Companion',
      },
      requiredScopes: ['mcp:read'],
      clientIdMetadataDocumentEnabled: true,
      accessTokenTTL: 3600,
      refreshTokenTTL: 60 * 60 * 24 * 30,
      // Keep provider diagnostics out of platform logs; public errors remain generic.
      onError: () => undefined,
    });

    return provider.fetch(request, env, context);
  },
};

function canonicalBase(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Invalid MCP_BASE_URL');
  }
  return url;
}

function isLocalhost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

