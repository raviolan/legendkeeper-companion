import test from 'node:test';
import assert from 'node:assert/strict';
import { developmentReadDiagnostics } from '../src/legendkeeper-diagnostics.mjs';
import { registerLegendKeeperTools } from '../src/legendkeeper-tools.mjs';

const enabled = { MCP_DEV_DIAGNOSTICS: 'true', LEGENDKEEPER_API_KEY: 'secret-api-key' };

test('diagnostics require explicit opt-in and localhost', () => {
  const logs = [];
  for (const [env, host] of [[{}, 'localhost'], [enabled, 'production.workers.dev'], [{ ...enabled, MCP_DEV_DIAGNOSTICS: 'false' }, 'localhost']]) {
    developmentReadDiagnostics(env, host, line => logs.push(line))('list_pages', new Error());
  }
  assert.deepEqual(logs, []);
});

test('diagnostics allowlist error types/status and synthesize messages without upstream details', () => {
  const logs = [];
  const report = developmentReadDiagnostics(enabled, 'localhost', line => logs.push(JSON.parse(line)));
  const error = Object.assign(new Error('secret-api-key Bearer token https://private/?secret=value private campaign'), {
    name: 'AuthenticationError', status: 401, response: { body: 'private campaign' },
  });
  report('list_pages', error);
  assert.deepEqual(logs[0], { event: 'legendkeeper_read_error', tool: 'list_pages',
    errorType: 'AuthenticationError', causeType: null, status: 401,
    message: 'LegendKeeper returned HTTP 401.', apiKeyBindingExists: true });
  report('list_pages', Object.assign(new Error('Illegal invocation: secret-api-key'), { name: 'ConnectionError', cause: new TypeError('private') }));
  assert.match(logs[1].message, /incorrect receiver/);
  report('list_pages', { name: 'secret-api-key', status: 'secret-api-key', message: 'private campaign' });
  assert.equal(logs[2].errorType, 'UnknownError');
  assert.doesNotMatch(JSON.stringify(logs), /secret-api-key|Bearer|private|https:/);
  const missing = [];
  developmentReadDiagnostics({ MCP_DEV_DIAGNOSTICS: 'true' }, 'localhost', line => missing.push(JSON.parse(line)))('configuration', new Error());
  assert.equal(missing[0].apiKeyBindingExists, false);
});

test('all tool failures report safely while public responses remain sanitized', async () => {
  const error = Object.assign(new Error('private campaign and secret'), { name: 'PermissionError', status: 403 });
  const fail = async () => { throw error; };
  const handlers = new Map();
  const reports = [];
  registerLegendKeeperTools({ registerTool(name, _config, handler) { handlers.set(name, handler); } },
    { search: { search: fail }, resources: { list: fail, get: fail } },
    { onReadError: (tool, e) => { reports.push([tool, e.status]); } });
  for (const [name, handler] of handlers) {
    const response = await handler({ query: 'test', resourceId: 'test' });
    assert.equal(response.isError, true);
    assert.doesNotMatch(JSON.stringify(response), /private|secret|PermissionError/);
    assert.deepEqual(reports.at(-1), [name, 403]);
  }
});

test('development diagnostics log only allowlisted read operations', () => {
  const lines = [];
  const report = developmentReadDiagnostics(enabled, 'localhost', line => lines.push(JSON.parse(line)));
  report('read_page', new TypeError('private text'), { operation: 'documents.list', response: 'private biography' });
  assert.equal(lines[0].operation, 'documents.list');
  report('read_page', new Error('private text'), { operation: 'private biography' });
  assert.equal(Object.hasOwn(lines[1], 'operation'), false);
  assert.doesNotMatch(JSON.stringify(lines), /private|biography/);
});
