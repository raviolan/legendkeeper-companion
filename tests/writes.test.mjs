import test from 'node:test';
import assert from 'node:assert/strict';
import { LegendKeeper } from '@legendkeeper/sdk';
import { registerLegendKeeperTools } from '../src/legendkeeper-tools.mjs';
const target = { resourceId: 'ng9bwvqp', documentId: 'l1gvpd6a', expectedVersion: 'v1' };
function fixture({ canWrite = true, failure, blocks, version = 'v1' } = {}) {
  const calls = [];
  const lk = new LegendKeeper({ apiKey: 'synthetic-key', maxRetries: 0, fetch: async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method, body, headers: init.headers });
    if (path.endsWith('/projects/')) return Response.json({ data: [{ id: 'project1' }] });
    if (failure && path.endsWith(failure.path) && (!failure.method || init.method === failure.method)) return Response.json({ message: 'secret synthetic-key', code: failure.code }, { status: failure.status });
    if (init.method !== 'GET') return Response.json({ id: 'newblock', version: 'v2', blocks: body?.blocks, ...body });
    if (path.endsWith('/blocks/')) return Response.json({ id: target.documentId, schema: 1, version, text: 'Old', blocks: blocks ?? [{ id: 'block123', kind: 'paragraph', content: [{ text: 'Old', bold: true }] }, { id: 'untouched', kind: 'unsupported' }] });
    if (path.endsWith('/docs/l1gvpd6a/')) return Response.json({ id: target.documentId, type: 'page', name: 'At the Market' });
    return Response.json({ id: target.resourceId, name: 'Perrin' });
  } });
  const tools = new Map();
  registerLegendKeeperTools({ registerTool: (name, config, handler) => tools.set(name, { config, handler }) }, lk, { canWrite });
  return { calls, tools, call: (name, input) => tools.get(name).handler(input) };
}
for (const canWrite of [false, true]) test(`write scope enforced: ${canWrite}`, async () => {
  const f = fixture({ canWrite });
  for (const [name, input] of [ ['append_page', { ...target, content: 'Hello' }], ['edit_page_block', { ...target, blockId: 'block123', content: 'New' }], ['replace_page_content', { ...target, content: 'New', mode: 'replace_entire_document' }], ['create_page', { name: 'NPC' }], ['update_resource', { resourceId: target.resourceId, name: 'NPC' }] ]) {
    const r = await f.call(name, input);
    assert.equal(r.isError === true, !canWrite, r.content[0].text);
  }
  if (!canWrite) assert.equal(f.calls.length, 0);
});
test('append is one atomic versioned insert with multiple paragraphs and no unrelated content', async () => {
  const f = fixture();
  const r = await f.call('append_page', { ...target, content: 'First\n\nSecond' });
  assert.notEqual(r.isError, true);
  const writes = f.calls.filter(c => c.method !== 'GET');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'POST');
  assert.match(writes[0].path, /resources\/ng9bwvqp\/docs\/l1gvpd6a\/blocks\/$/);
  assert.equal(writes[0].headers['if-match'], 'v1');
  assert.equal(writes[0].body.block.children.length, 2);
  assert.doesNotMatch(JSON.stringify(writes), /untouched|Old|iipp4vpj|fkxt16w5/);
});
test('edit patches only specified block text and uses If-Match', async () => {
  const f = fixture();
  await f.call('edit_page_block', { ...target, blockId: 'block123', content: 'New' });
  const write = f.calls.find(c => c.method === 'PATCH');
  assert.match(write.path, /blocks\/block123\/$/);
  assert.deepEqual(write.body, { content: [{ text: 'New' }] });
  assert.equal(write.headers['if-match'], 'v1');
});
test('replacement requires acknowledgement and returns changed document version', async () => {
  const f = fixture();
  assert.equal((await f.call('replace_page_content', { ...target, content: 'New' })).isError, true);
  const r = await f.call('replace_page_content', { ...target, content: 'New', mode: 'replace_entire_document' });
  assert.equal(JSON.parse(r.content[0].text).document.version, 'v2');
  assert.equal(f.calls.find(c => c.method === 'PUT').headers['if-match'], 'v1');
});
test('create uses atomic resource+documents body; metadata never moves resources', async () => {
  const f = fixture();
  await f.call('create_page', { name: 'Shop', parentId: 'parent12', content: 'Stock', tags: ['market'] });
  const create = f.calls.find(c => c.method === 'POST');
  assert.equal(create.body.parentId, 'parent12');
  assert.equal(create.body.documents[0].blocks[0].kind, 'paragraph');
  await f.call('update_resource', { resourceId: target.resourceId, aliases: ['P'], tags: [] });
  assert.deepEqual(f.calls.find(c => c.method === 'PATCH').body, { aliases: ['P'], tags: [] });
  assert.equal((await f.call('update_resource', { resourceId: target.resourceId, parentId: 'bad' })).isError, true);
});
test('missing, duplicate and unsupported block IDs fail without writes', async () => {
  for (const blocks of [[], [{ id: 'b', kind: 'paragraph' }, { id: 'b', kind: 'paragraph' }], [{ id: 'b', kind: 'unsupported' }]]) {
    const f = fixture({ blocks });
    assert.equal((await f.call('edit_page_block', { ...target, blockId: 'b', content: 'X' })).isError, true);
    assert.ok(f.calls.every(c => c.method === 'GET'));
  }
});
test('stale versions and race conflicts fail without retry or secret disclosure', async () => {
  const stale = fixture({ version: 'v2' });
  assert.equal((await stale.call('append_page', { ...target, content: 'X' })).isError, true);
  assert.ok(stale.calls.every(c => c.method === 'GET'));
  for (const failure of [ { path: '/blocks/', method: 'POST', status: 412, code: 'VERSION_MISMATCH' }, { path: '/resources/ng9bwvqp/', status: 404, code: 'NOT_FOUND' }, { path: '/docs/l1gvpd6a/', status: 404, code: 'NOT_FOUND' }, { path: '/blocks/', method: 'POST', status: 500, code: 'INTERNAL' } ]) {
    const f = fixture({ failure });
    const r = await f.call('append_page', { ...target, content: 'X' });
    assert.equal(r.isError, true);
    assert.doesNotMatch(JSON.stringify(r), /synthetic-key|secret/);
    assert.ok(f.calls.filter(c => c.method !== 'GET').length <= 1);
    if (failure.status === 412) assert.match(r.content[0].text, /Conflict/);
  }
});
test('inspection exposes rich blocks and version without writing', async () => {
  const f = fixture({ canWrite: false });
  const r = await f.call('read_document_blocks', { resourceId: target.resourceId, documentId: target.documentId });
  assert.equal(JSON.parse(r.content[0].text).blocks[0].content[0].bold, true);
  assert.ok(f.calls.every(c => c.method === 'GET'));
});
