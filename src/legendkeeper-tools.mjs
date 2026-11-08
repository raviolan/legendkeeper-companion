import { registerWriteTools } from './legendkeeper-writes.mjs';
import * as z from 'zod/v4';

/**
 * @param {import('@modelcontextprotocol/server').McpServer} server
 * @param {import('@legendkeeper/sdk').LegendKeeper} lk
 * @param {{ canWrite?: boolean, onReadError?: (tool: string, error: unknown, details?: { operation: string }) => void }} [options]
 */
export function registerLegendKeeperTools(server, lk, options = {}) {
  registerWriteTools(server, lk, options);
  server.registerTool('search_campaign', {
    title: 'Search campaign',
    description: 'Search LegendKeeper campaign lore, NPCs, locations and notes.',
    inputSchema: z.object({ query: z.string().min(1) }),
    annotations: { readOnlyHint: true },
  }, async ({ query }) => {
    try {
      const page = await lk.search.search({ q: query, limit: 30 });
      return textResult({
        data: page.data.map((hit) => ({
          resource: hit.resource,
          document: hit.document,
        })),
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      try { options.onReadError?.('search_campaign', error); } catch { /* Keep diagnostics isolated. */ }
      return toolError(error);
    }
  });

  server.registerTool('list_pages', {
    title: 'List pages',
    description: 'List LegendKeeper resources with pagination.',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().optional(),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ limit, cursor }) => {
    try {
      const page = await lk.resources.list({ limit: limit ?? 50, cursor });
      return textResult({
        data: page.data,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      try { options.onReadError?.('list_pages', error); } catch { /* Keep diagnostics isolated. */ }
      return toolError(error);
    }
  });

  server.registerTool('read_page', {
    title: 'Read page',
    description: 'Read a LegendKeeper resource and the text of its page documents.',
    inputSchema: z.object({ resourceId: z.string().min(1) }),
    annotations: { readOnlyHint: true },
  }, async ({ resourceId }) => {
    let operation = 'resources.get';
    try {
      const resource = await lk.resources.get({ resourceId });
      const documents = [];
      const skippedDocuments = [];
      operation = 'documents.list';
      // SDK 4.1 resolves to an iterable Page; the Promise itself is not iterable.
      const page = await lk.documents.list({ resourceId });
      for await (const document of page) {
        if (document.type !== 'page' && document.type !== 'blank') {
          skippedDocuments.push({ id: document.id, name: document.name, type: document.type,
            reason: 'This document type does not expose page text.' });
          continue;
        }
        operation = 'documents.getBlocks';
        const content = await lk.documents.getBlocks({
          resourceId,
          documentId: document.id,
        });
        // text is required by DocumentBlocks. Missing text is a failed read,
        // not evidence that a biography is empty. Blocks are returned in full.
        if (typeof content?.text !== 'string') throw new TypeError('Invalid document text response');
        documents.push({
          id: document.id,
          name: document.name,
          type: document.type,
          text: content.text,
        });
        operation = 'documents.list';
      }

      return textResult({
        resource: {
          id: resource.id,
          name: resource.name,
          parentId: resource.parentId,
          tags: resource.tags,
          aliases: resource.aliases,
          path: resource.path,
        },
        documents,
        ...(skippedDocuments.length ? { skippedDocuments } : {}),
      });
    } catch (error) {
      try { options.onReadError?.('read_page', error, { operation }); } catch { /* Keep diagnostics isolated. */ }
      return toolError(error, operation);
    }
  });
}

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function toolError(error, operation) {
  if (error instanceof Error && error.name === 'NotFoundError') {
    const subject = operation === 'documents.getBlocks' ? 'document' : 'resource';
    return { isError: true, content: [{ type: 'text', text: `LegendKeeper ${subject} was not found or is not accessible.` }] };
  }
  if (operation === 'documents.list' || operation === 'documents.getBlocks') {
    const message = operation === 'documents.list'
      ? 'LegendKeeper could not list this resource’s documents.'
      : 'LegendKeeper could not read this document’s page content.';
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
  // Do not return SDK error bodies, request details, credentials, or upstream diagnostics.
  return { isError: true, content: [{ type: 'text', text: 'LegendKeeper could not complete this read request.' }] };
}
