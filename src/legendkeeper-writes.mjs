import * as z from 'zod/v4';
import { p, walk } from '@legendkeeper/sdk/blocks';

const id = z.string().min(1).max(128);
const text = z.string().min(1).max(100000);
const target = { resourceId: id, documentId: id };
const version = { expectedVersion: z.string().min(1).max(256) };
const metadata = { name: z.string().min(1).max(500).optional(), tags: z.array(id).max(100).optional(), aliases: z.array(z.string().min(1).max(500)).max(100).optional() };
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
class SafeError extends Error {}
const paragraphs = value => value.split(/\r?\n\s*\r?\n/).map(value => p(value));

export function registerWriteTools(server, lk, { canWrite = false } = {}) {
  function register(name, description, shape, action, destructive = false, readOnly = false) {
    const schema = z.strictObject(shape);
    server.registerTool(name, { description, inputSchema: schema,
      annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: readOnly, openWorldHint: true } }, async input => {
      if (!readOnly && !canWrite) return { isError: true, content: [{ type: 'text', text: 'Insufficient scope: mcp:write is required. Reauthorize with write permission.' }] };
      try { return result(await action(schema.parse(input))); }
      catch (error) {
        const message = error instanceof SafeError ? error.message
          : error?.status === 412 || error?.code === 'VERSION_MISMATCH' ? 'Conflict: document changed. Read the latest blocks and retry with its version.'
          : error?.status === 409 ? 'Conflict: block identifier is ambiguous or already used. Inspect the latest document before retrying.'
          : error?.status === 404 || error?.name === 'NotFoundError' ? 'Resource, document, or block was not found or is not accessible.'
          : error instanceof z.ZodError ? 'Invalid tool input.'
          : 'LegendKeeper request failed. A write outcome may be unknown; inspect the target before retrying. No automatic retry was performed.';
        return { isError: true, content: [{ type: 'text', text: message }] };
      }
    });
  }
  async function inspect(input) {
    const doc = { resourceId: input.resourceId, documentId: input.documentId };
    await lk.resources.get({ resourceId: doc.resourceId });
    const info = await lk.documents.get(doc);
    if (info.id !== doc.documentId || !['page', 'blank'].includes(info.type)) throw new SafeError('Target must be the specified page or blank document within the resource.');
    const state = await lk.documents.getBlocks(doc);
    if (state.id !== doc.documentId || !Array.isArray(state.blocks) || typeof state.version !== 'string' || !state.version) throw new SafeError('Invalid document state; no write attempted.');
    if (input.expectedVersion !== undefined && input.expectedVersion !== state.version) throw new SafeError('Conflict: document changed. Read the latest blocks and retry with its version.');
    return { doc, state };
  }
  register('read_document_blocks', 'Inspect one document, including full rich blocks, IDs and version. Use before editing; resourceId and documentId are distinct.', target, async input => {
    const { state } = await inspect(input);
    return { resourceId: input.resourceId, documentId: input.documentId, ...state };
  }, false, true);
  register('append_page', 'Append plain-text paragraphs atomically in a new text container. Existing blocks and other documents are preserved. Inspect the document first.', { ...target, ...version, content: text }, async input => {
    const { doc, state } = await inspect(input);
    const written = await lk.blocks.insert(doc, { block: { kind: 'textField', children: paragraphs(input.content), isTitleHidden: true }, ifMatch: state.version });
    return { success: true, ...doc, previousVersion: state.version, version: written.version, appendedBlock: written };
  });
  register('edit_page_block', 'Replace the text runs of one paragraph, heading or quote identified by its exact unique ID. Formatting inside that block is replaced; children and all unrelated blocks are preserved.', { ...target, ...version, blockId: id, content: text }, async input => {
    const { doc, state } = await inspect(input);
    const matches = [];
    walk(state, block => { if (block.id === input.blockId) matches.push(block); });
    if (matches.length !== 1) throw new SafeError('Block ID is missing or ambiguous. Inspect the document; no write attempted.');
    if (!['paragraph', 'heading', 'quote'].includes(matches[0].kind)) throw new SafeError('Only paragraph, heading and quote text can be edited by this tool. No write attempted.');
    const written = await lk.blocks.update({ ...doc, blockId: input.blockId }, { content: [{ text: input.content }], ifMatch: state.version });
    return { success: true, ...doc, blockId: input.blockId, previousVersion: state.version, version: written.version, block: written };
  }, true);
  register('replace_page_content', 'Destructively replace ONLY this document with plain-text paragraphs. Use only when the user explicitly requests complete replacement. Never use as an append/edit fallback.', { ...target, ...version, mode: z.literal('replace_entire_document'), content: text }, async input => {
    const { doc, state } = await inspect(input);
    const written = await lk.documents.replaceBlocks(doc, { blocks: paragraphs(input.content), ifMatch: state.version });
    return { success: true, ...doc, previousVersion: state.version, previousTopLevelBlocks: state.blocks.length, document: written };
  }, true);
  register('create_page', 'Create a resource with one Overview document atomically, optionally under a parent resource. Content is plain text.', { ...metadata, name: z.string().min(1).max(500), parentId: id.optional(), content: text.optional() }, async input => {
    const { content, ...fields } = input;
    if (fields.parentId) await lk.resources.get({ resourceId: fields.parentId });
    const resource = await lk.resources.create({ ...fields, documents: [{ name: 'Overview', type: 'page', blocks: content ? paragraphs(content) : [] }] });
    return { success: true, resource };
  });
  register('update_resource', 'Patch name, tags or aliases only. Arrays replace their respective fields. No move or deletion. SDK does not offer resource metadata version checks.', { resourceId: id, ...metadata }, async input => {
    const { resourceId, ...patch } = input;
    if (!Object.keys(patch).length) throw new SafeError('Provide at least one metadata field.');
    await lk.resources.get({ resourceId });
    return { success: true, changedFields: Object.keys(patch), resource: await lk.resources.update({ resourceId }, patch) };
  }, true);
}
