import test from 'node:test';
import assert from 'node:assert/strict';
import { LegendKeeper } from '@legendkeeper/sdk';
import { registerLegendKeeperTools } from '../src/legendkeeper-tools.mjs';

function setup(lk, options) {
  const tools = new Map();
  const server = {
    registerTool(name, config, handler) {
      tools.set(name, { config, handler });
    },
  };
  registerLegendKeeperTools(server, lk, options);
  return tools;
}

function payload(result) {
  return JSON.parse(result.content[0].text);
}

test('registers only the three read-only campaign tools', () => {
  const tools = setup({});
  assert.deepEqual([...tools.keys()], ['search_campaign', 'list_pages', 'read_page']);
  for (const { config } of tools.values()) assert.equal(config.annotations.readOnlyHint, true);
});

test('search_campaign returns useful hit metadata and pagination', async () => {
  const tools = setup({
    search: { search: async (input) => {
      assert.deepEqual(input, { q: 'dragon', limit: 30 });
      return { data: [{ resource: { id: 'r1', name: 'Dragon' }, document: { id: 'd1', name: 'Bestiary' } }], hasMore: true, nextCursor: 'next' };
    } },
  });
  const result = await tools.get('search_campaign').handler({ query: 'dragon' });
  assert.deepEqual(payload(result), {
    data: [{ resource: { id: 'r1', name: 'Dragon' }, document: { id: 'd1', name: 'Bestiary' } }],
    hasMore: true,
    nextCursor: 'next',
  });
});

test('list_pages passes pagination and preserves the returned cursor', async () => {
  const tools = setup({
    resources: { list: async (input) => {
      assert.deepEqual(input, { limit: 7, cursor: 'page-2' });
      return { data: [{ id: 'r2', name: 'Harbor' }], hasMore: false, nextCursor: null };
    } },
  });
  const result = await tools.get('list_pages').handler({ limit: 7, cursor: 'page-2' });
  assert.deepEqual(payload(result), { data: [{ id: 'r2', name: 'Harbor' }], hasMore: false, nextCursor: null });
});

test('read_page returns page document text and handles empty documents', async () => {
  const docs = [
    { id: 'd1', name: 'Overview', type: 'page' },
    { id: 'd2', name: 'Map', type: 'map' },
    { id: 'd3', name: 'Empty page', type: 'page' },
  ];
  const lk = {
    resources: { get: async ({ resourceId }) => ({ id: resourceId, name: 'Harbor', parentId: null, tags: [], aliases: [], path: '/Harbor' }) },
    documents: {
      list: async ({ resourceId }) => {
        assert.equal(resourceId, 'r1');
        return { async *[Symbol.asyncIterator]() { yield* docs; } };
      },
      getBlocks: async ({ documentId }) => ({ text: documentId === 'd1' ? 'A busy port.' : '' }),
    },
  };
  const result = await setup(lk).get('read_page').handler({ resourceId: 'r1' });
  assert.deepEqual(payload(result), {
    resource: { id: 'r1', name: 'Harbor', parentId: null, tags: [], aliases: [], path: '/Harbor' },
    documents: [
      { id: 'd1', name: 'Overview', type: 'page', text: 'A busy port.' },
      { id: 'd3', name: 'Empty page', type: 'page', text: '' },
    ],
    skippedDocuments: [{ id: 'd2', name: 'Map', type: 'map', reason: 'This document type does not expose page text.' }],
  });
});

test('read_page turns missing resources into a safe not-found result', async () => {
  const tools = setup({ resources: { get: async () => { const error = new Error('private upstream detail'); error.name = 'NotFoundError'; throw error; } } });
  const result = await tools.get('read_page').handler({ resourceId: 'missing' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not found or is not accessible/);
  assert.doesNotMatch(result.content[0].text, /private upstream detail/);
});

// Real SDK transport fixture: unlike an async-generator mock, documents.list()
// returns Promise<Page>. The HTTP fixtures use the installed v4.1 API contract.
function sdkFixture({ resource = { id: 'character-1', name: 'Character', documents: [] }, docs = [], blocks = {}, failure } = {}) {
  const calls = [];
  const lk = new LegendKeeper({ apiKey: 'test-only-key', maxRetries: 0,
    fetch: async (input, init) => {
      const url = new URL(input);
      assert.equal(url.origin, 'https://www.legendkeeper.com');
      assert.equal(init.method, 'GET');
      assert.equal(init.headers.authorization, 'Bearer test-only-key');
      const path = url.pathname;
      calls.push(path);
      if (failure && path.endsWith(failure.path)) return Response.json({ message: 'private biography test-only-key' }, { status: failure.status });
      if (path === '/api/v3/projects/') return Response.json({ data: [{ id: 'project-1' }], hasMore: false, nextCursor: null });
      if (path.endsWith('/resources/character-1/')) return Response.json(resource);
      if (path.endsWith('/resources/character-1/docs/')) return Response.json({ data: docs, hasMore: false, nextCursor: null });
      const documentId = path.match(/\/docs\/([^/]+)\/blocks\/$/)?.[1];
      assert.ok(documentId, 'Expected a page-content read');
      assert.ok(Object.hasOwn(blocks, documentId));
      return Response.json(blocks[documentId]);
    },
  });
  return { lk, calls };
}

test('real SDK Promise<Page> reads a character Overview and every text-bearing block', async () => {
  const docs = [{ id: 'overview', name: 'Overview', type: 'page' }];
  const content = { id: 'overview', version: 'v1', schema: 1, text: 'First paragraph.\nSecond paragraph.',
    blocks: [ { kind: 'paragraph', content: [{ text: 'First paragraph.' }] }, { kind: 'paragraph', content: [{ text: 'Second paragraph.' }] } ] };
  const { lk, calls } = sdkFixture({ resource: { id: 'character-1', name: 'Character', documents: docs }, docs, blocks: { overview: content } });
  const response = await setup(lk).get('read_page').handler({ resourceId: 'character-1' });
  assert.notEqual(response.isError, true);
  assert.equal(payload(response).resource.name, 'Character');
  assert.deepEqual(payload(response).documents, [{ ...docs[0], text: content.text }]);
  assert.equal(calls.length, 4); // project resolution, resource, documents, all blocks
});

test('real SDK handles multiple pages, blank/empty documents, and explicit unsupported types', async () => {
  const docs = [
    { id: 'overview', name: 'Overview', type: 'page' },
    { id: 'biography', name: 'Biography', type: 'page' },
    { id: 'empty', name: 'Empty', type: 'page' },
    { id: 'blank', name: 'New document', type: 'blank' },
    ...['map', 'board', 'time', 'future-type'].map(type => ({ id: type, name: type, type })),
  ];
  const blocks = Object.fromEntries(docs.slice(0, 4).map((doc, index) => [doc.id, {
    id: doc.id, version: 'v1', schema: 1, blocks: [], text: index < 2 ? `Document ${index}` : '',
  }]));
  const { lk, calls } = sdkFixture({ docs, blocks });
  const response = await setup(lk).get('read_page').handler({ resourceId: 'character-1' });
  assert.notEqual(response.isError, true);
  const data = payload(response);
  assert.deepEqual(data.documents.map(d => d.id), ['overview', 'biography', 'empty', 'blank']);
  assert.deepEqual(data.documents.map(d => d.text), ['Document 0', 'Document 1', '', '']);
  assert.deepEqual(data.skippedDocuments.map(d => d.type), ['map', 'board', 'time', 'future-type']);
  assert.equal(calls.filter(path => path.endsWith('/blocks/')).length, 4);
});

test('a folder with no documents does not require resource.documents to exist', async () => {
  const { lk } = sdkFixture({ resource: { id: 'character-1', name: 'Folder' } });
  const response = await setup(lk).get('read_page').handler({ resourceId: 'character-1' });
  assert.notEqual(response.isError, true);
  assert.deepEqual(payload(response).documents, []);
});

test('missing document text fails rather than claiming an empty successful biography', async () => {
  const { lk } = sdkFixture({ docs: [{ id: 'overview', name: 'Overview', type: 'page' }],
    blocks: { overview: { id: 'overview', blocks: [], schema: 1, version: 'v1' } } });
  const response = await setup(lk).get('read_page').handler({ resourceId: 'character-1' });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /could not read/);
});

test('real SDK read errors identify the operation without leaking upstream details or partial content', async () => {
  for (const [path, status, operation] of [
    ['/resources/character-1/', 404, 'resources.get'],
    ['/docs/', 403, 'documents.list'],
    ['/docs/biography/blocks/', 500, 'documents.getBlocks'],
  ]) {
    const { lk } = sdkFixture({ docs: [{ id: 'overview', name: 'Overview', type: 'page' }, { id: 'biography', name: 'Biography', type: 'page' }],
      blocks: { overview: { text: 'Already read private biography' } }, failure: { path, status } });
    const reports = [];
    const response = await setup(lk, { onReadError: (_tool, error, details) => reports.push({ operation: details.operation, status: error.status }) })
      .get('read_page').handler({ resourceId: 'character-1' });
    assert.equal(response.isError, true);
    assert.deepEqual(reports, [{ operation, status }]);
    assert.doesNotMatch(JSON.stringify(response), /private|biography|test-only-key|Already read/);
  }
});
