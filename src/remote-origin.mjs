// One origin remains supported; comma-separated origins allow explicit Inspector
// localhost/127.0.0.1 entries without enabling every loopback port or wildcard.
export function configuredCorsOrigins(value) {
  if (!value) return [];
  return [...new Set(value.split(',').map((entry) => {
    const origin = parseOrigin(entry.trim());
    if (!origin) throw new Error('MCP_CORS_ORIGIN must contain HTTP(S) origins separated by commas');
    return origin;
  }))];
}

function parseOrigin(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

export function isAllowedRequestOrigin(request, baseOrigin, configuredOrigin) {
  const allowed = configuredCorsOrigins(configuredOrigin);
  const requestOrigin = request.headers.get('Origin');
  if (requestOrigin === null) return true;
  const normalized = parseOrigin(requestOrigin);
  return normalized !== null && (normalized === baseOrigin || allowed.includes(normalized));
}

// The handler accepts a single response Origin. Select it only after exact-origin
// validation; never emit a comma-separated Access-Control-Allow-Origin value.
export function mcpCorsOptions(request, baseOrigin, configuredOrigin) {
  if (!isAllowedRequestOrigin(request, baseOrigin, configuredOrigin)) return false;
  const origin = request.headers.get('Origin');
  const normalized = origin ? parseOrigin(origin) : null;
  return normalized ? { origin: normalized } : false;
}

export function mcpOriginHostnames(baseHostname, configuredOrigin) {
  return [...new Set([baseHostname, ...configuredCorsOrigins(configuredOrigin).map(origin => new URL(origin).hostname)])];
}

export function handleMcpPreflight(request, baseOrigin, configuredOrigin) {
  const cors = mcpCorsOptions(request, baseOrigin, configuredOrigin);
  const requestedHeaders = (request.headers.get('Access-Control-Request-Headers') ?? '')
    .split(',').map((header) => header.trim().toLowerCase()).filter(Boolean);
  const permittedHeaders = new Set(['accept', 'authorization', 'content-type', 'mcp-protocol-version', 'mcp-method', 'mcp-name', 'mcp-session-id']);
  const requestedMethod = request.headers.get('Access-Control-Request-Method');
  if (!cors || (requestedMethod && requestedMethod !== 'POST') || requestedHeaders.some((header) => !permittedHeaders.has(header))) {
    return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store', Vary: 'Origin' } });
  }

  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': cors.origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Accept, Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id',
      'Access-Control-Max-Age': '600',
      'Cache-Control': 'no-store',
      Vary: 'Origin',
    },
  });
}
