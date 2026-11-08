import { LegendKeeper } from '@legendkeeper/sdk';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { registerLegendKeeperTools } from './src/legendkeeper-tools.mjs';

const apiKey = process.env.LEGENDKEEPER_API_KEY;

if (!apiKey) {
  console.error('Missing LEGENDKEEPER_API_KEY');
  process.exit(1);
}

const lk = new LegendKeeper({ apiKey, maxRetries: 0 });

function createServer() {
  const server = new McpServer({
    name: 'legendkeeper-companion',
    version: '1.0.0'
  });
  registerLegendKeeperTools(server, lk, { canWrite: process.env.LEGENDKEEPER_ENABLE_WRITES === 'true' });

  return server;
}

await serveStdio(createServer);
