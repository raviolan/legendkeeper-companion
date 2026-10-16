// Read-only local probe. Never prints IDs, document names, text, or raw SDK errors.
import { LegendKeeper } from '@legendkeeper/sdk';
import { registerLegendKeeperTools } from '../src/legendkeeper-tools.mjs';
import { developmentReadDiagnostics } from '../src/legendkeeper-diagnostics.mjs';

const resourceId = process.argv[2];
const apiKey = process.env.LEGENDKEEPER_API_KEY;
if (!resourceId || !apiKey) {
  console.error(JSON.stringify({ succeeded: false, resourceIdProvided: Boolean(resourceId), apiKeyBindingExists: Boolean(apiKey) }));
  process.exit(1);
}
const lk = new LegendKeeper({ apiKey, fetch: (input, init) => globalThis.fetch(input, init),
  timeoutMs: 10_000, maxRetries: 0 });
const handlers = new Map();
registerLegendKeeperTools({ registerTool(name, _config, handler) { handlers.set(name, handler); } }, lk, {
  onReadError: developmentReadDiagnostics({ LEGENDKEEPER_API_KEY: apiKey, MCP_DEV_DIAGNOSTICS: 'true' }, 'localhost'),
});
const result = await handlers.get('read_page')({ resourceId });
if (result.isError) {
  console.log(JSON.stringify({ succeeded: false, toolError: result.content[0].text }));
  process.exitCode = 1;
} else {
  const data = JSON.parse(result.content[0].text);
  const overview = data.documents.find(document => document.name?.toLowerCase() === 'overview');
  console.log(JSON.stringify({ succeeded: true, readableDocumentCount: data.documents.length,
    emptyDocumentCount: data.documents.filter(document => document.text === '').length,
    skippedDocumentCount: data.skippedDocuments?.length ?? 0,
    overviewPresent: Boolean(overview), overviewHasText: Boolean(overview?.text.trim()) }));
}
