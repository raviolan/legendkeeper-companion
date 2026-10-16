// Never log upstream messages/bodies: they can contain credentials or campaign text.
const ERROR_NAMES = new Set([
  'Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError',
  'ConnectionError', 'LegendKeeperError', 'AuthenticationError', 'PermissionError',
  'NotFoundError', 'ValidationError', 'ConflictError', 'VersionMismatchError',
  'RateLimitError', 'ServerError',
]);

export function developmentReadDiagnostics(env, hostname, write = value => console.error(value)) {
  const enabled = env.MCP_DEV_DIAGNOSTICS === 'true' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  return (tool, error, details = {}) => {
    if (!enabled) return;
    const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599
      ? error.status : null;
    const errorType = ERROR_NAMES.has(error?.name) ? error.name : 'UnknownError';
    const causeType = ERROR_NAMES.has(error?.cause?.name) ? error.cause.name : null;
    let message = 'Read failed; upstream details withheld.';
    if (error?.message === 'Malformed JSON response' || errorType === 'SyntaxError') message = 'Response could not be parsed as JSON.';
    else if (status) message = `LegendKeeper returned HTTP ${status}.`;
    else if (errorType === 'ConnectionError') {
      message = /\bIllegal invocation\b/.test(String(error?.message))
        ? 'Fetch failed: Illegal invocation (incorrect receiver).'
        : 'Fetch failed before receiving an HTTP response (network, TLS, or timeout).';
    } else if (errorType === 'TypeError' && /^Expected the API key to resolve exactly one project, got \d+;/.test(String(error?.message))) {
      message = 'API key did not resolve exactly one project.';
    } else if (!env.LEGENDKEEPER_API_KEY) message = 'API key binding is missing.';
    // An explicit field allowlist is safer than trying to redact arbitrary SDK errors.
    try {
      const operation = ['resources.get', 'documents.list', 'documents.getBlocks'].includes(details.operation) ? details.operation : undefined;
      write(JSON.stringify({ event: 'legendkeeper_read_error', tool, ...(operation ? { operation } : {}),
        errorType, causeType, status, message, apiKeyBindingExists: Boolean(env.LEGENDKEEPER_API_KEY) }));
    } catch { /* Diagnostics must never change the tool result. */ }
  };
}
