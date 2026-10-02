import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentService, referenceSearch } from '../src/index.js';

async function makeDir() {
  return mkdtemp(join(tmpdir(), 'document-index-'));
}

async function reopen(service, dir, options = {}) {
  await service.close();
  return DocumentService.open(dir, { flushThreshold: Infinity, ...options });
}

async function allPages(service, query, pageSize, onPage) {
  const out = [];
  let cursor;
  let snapshotId;
  for (;;) {
    const page = await service.query(query, { pageSize, cursor });
    snapshotId ??= page.snapshotId;
    out.push(...page.matches);
    await onPage?.(page, out);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { matches: out, snapshotId };
}

async function segmentFiles(dir) {
  return (await readdir(dir)).filter((name) => name.startsWith('segment-'));
}

function expectSameAsReference(snapshotDocs, query, actual) {
  const expected = referenceSearch(new Map(Object.entries(snapshotDocs)), query);
  assert.deepEqual(actual.map(({ docId }) => docId), expected.map(({ docId }) => docId));
}

test('indexes revisions, tombstones, term intersections and phrases', async () => {
  const dir = await makeDir();
  try {
    const service = await DocumentService.open(dir, { flushThreshold: Infinity });

    await service.put('doc-1', 0, 'The quick brown fox jumps.');
    await service.put('doc-2', 0, 'Quick fox: another quick brown fox.');
    await service.put('doc-3', 0, 'brown dog');
    await service.flush();

    const terms = await service.query('quick brown', { pageSize: 10 });
    assert.deepEqual(terms.matches.map((m) => m.docId), ['doc-1', 'doc-2']);
    assert.deepEqual(terms.matches[0].evidence.matchedTerms[0], {
      term: 'quick',
      positions: [1],
    });

    const phrase = await service.query('"quick brown" fox', { pageSize: 10 });
    assert.deepEqual(phrase.matches.map((m) => m.docId), ['doc-1', 'doc-2']);
    assert.deepEqual(phrase.matches[0].evidence.phrases[0].starts, [{ position: 1, end: 2 }]);

    await service.put('doc-1', 1, 'brown fox, but no longer fast');
    await service.delete('doc-2', 1);
    await service.delete('doc-3', 1);
    await service.flush();
    await service.merge();

    const afterUpdate = await service.query('quick brown', { pageSize: 10 });
    assert.deepEqual(afterUpdate.matches.map((m) => m.docId), []);
    const brown = await service.query('brown', { pageSize: 10 });
    assert.deepEqual(brown.matches.map((m) => m.docId), ['doc-1']);
    assert.equal(brown.matches[0].revision, 1);

    const reopened = await reopen(service, dir);
    const afterRestart = await reopened.query('brown fox', { pageSize: 10 });
    assert.deepEqual(afterRestart.matches.map((m) => m.docId), ['doc-1']);
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cursor remains bound to its snapshot through writes, flushes and merges', async () => {
  const dir = await makeDir();
  try {
    let service = await DocumentService.open(dir, { flushThreshold: Infinity });
    const snapshotDocs = {};

    for (let i = 0; i < 10; i++) {
      const id = `doc-${String(i).padStart(2, '0')}`;
      const text = `alpha beta ${String(i).padStart(2, '0')}`;
      await service.put(id, 0, text);
      snapshotDocs[id] = { rev: 0, text };
    }
    await service.flush();

    const collected = [];
    let cursor;
    let snapshotId;
    for (let pageNumber = 0; ; pageNumber++) {
      const page = await service.query('alpha beta', { pageSize: 3, cursor });
      snapshotId ??= page.snapshotId;
      collected.push(...page.matches);
      const newId = `new-${pageNumber}`;
      await service.put(newId, 0, 'alpha beta added during paging');
      await service.flush();
      if (pageNumber === 1) await service.merge();

      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    assert.deepEqual(collected.map((m) => m.docId), Object.keys(snapshotDocs).sort());
    const current = await service.query('alpha beta', { pageSize: 100 });
    assert.equal(current.matches.length, 14);
    assert.notEqual(current.snapshotId, snapshotId);

    service = await reopen(service, dir);
    const afterRestart = await service.query('alpha beta', { pageSize: 100 });
    assert.equal(afterRestart.matches.length, 14);
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('merge atomically keeps old segments until cursors release them', async () => {
  const dir = await makeDir();
  try {
    const service = await DocumentService.open(dir, { flushThreshold: Infinity });
    await service.put('a', 0, 'snapshot word');
    await service.put('b', 0, 'snapshot word');
    await service.flush();
    await service.put('c', 0, 'snapshot word');
    await service.put('d', 0, 'snapshot word');
    await service.flush();

    const first = await service.query('snapshot', { pageSize: 1 });
    assert.equal(first.hasMore, true);
    const beforeMerge = await segmentFiles(dir);
    assert.equal(beforeMerge.length, 2);

    const merged = await service.merge();
    assert.equal(merged.reclaimError, null);
    const duringCursor = await segmentFiles(dir);
    assert.equal(duringCursor.length, 3);

    const second = await service.query('snapshot', {
      pageSize: 10,
      cursor: first.nextCursor,
    });
    assert.deepEqual(second.matches.map((m) => m.docId), ['b', 'c', 'd']);

    const afterCursor = await segmentFiles(dir);
    assert.deepEqual(afterCursor, [merged.segmentId].map((id) => `segment-${String(id).padStart(12, '0')}.json`));
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('segment and manifest flush failures roll back while service stays queryable', async () => {
  const dir = await makeDir();
  try {
    let service = await DocumentService.open(dir, { flushThreshold: Infinity });
    await service.put('a', 0, 'crash word');
    service.injectFault('segmentWrite');
    await assert.rejects(() => service.flush(), /injected segmentWrite failure/);

    let page = await service.query('crash', { pageSize: 10 });
    assert.deepEqual(page.matches.map((m) => m.docId), ['a']);
    await service.flush();

    await service.put('b', 0, 'crash word two');
    service.injectFault('manifestWrite');
    await assert.rejects(() => service.flush(), /injected manifestWrite failure/);
    page = await service.query('crash', { pageSize: 10 });
    assert.deepEqual(page.matches.map((m) => m.docId), ['a', 'b']);

    await service.flush();
    const files = await segmentFiles(dir);
    assert.equal(files.length, 2);

    service = await reopen(service, dir);
    page = await service.query('crash', { pageSize: 10 });
    assert.deepEqual(page.matches.map((m) => m.docId), ['a', 'b']);
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('merge failures leave a complete committed state and restart recovery removes garbage', async () => {
  const dir = await makeDir();
  try {
    let service = await DocumentService.open(dir, { flushThreshold: Infinity });
    await service.put('a', 0, 'merge word');
    await service.flush();
    await service.put('b', 0, 'merge word');
    await service.flush();

    service.injectFault('segmentWrite');
    await assert.rejects(() => service.merge(), /injected segmentWrite failure/);
    let page = await service.query('merge', { pageSize: 10 });
    assert.deepEqual(page.matches.map((m) => m.docId), ['a', 'b']);

    service.injectFault('manifestWrite');
    await assert.rejects(() => service.merge(), /injected manifestWrite failure/);
    page = await service.query('merge', { pageSize: 10 });
    assert.deepEqual(page.matches.map((m) => m.docId), ['a', 'b']);

    let result = await service.merge();
    assert.equal(result.merged, true);
    assert.equal(result.reclaimError, null);
    page = await service.query('merge', { pageSize: 10 });
    assert.deepEqual(page.matches.map((m) => m.docId), ['a', 'b']);

    service = await reopen(service, dir);
    const files = await segmentFiles(dir);
    assert.equal(files.length, 1);
    page = await service.query('merge', { pageSize: 10 });
    assert.deepEqual(page.matches.map((m) => m.docId), ['a', 'b']);
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reclaim failure retains files but the published merge remains queryable', async () => {
  const dir = await makeDir();
  try {
    let service = await DocumentService.open(dir, { flushThreshold: Infinity });
    await service.put('a', 0, 'reclaim word');
    await service.flush();
    await service.put('b', 0, 'reclaim word');
    await service.flush();

    service.injectFault('reclaim');
    const merged = await service.merge();
    assert.equal(merged.merged, true);
    assert.equal(merged.reclaimError.code, 'INJECTED_FAULT');
    assert.equal((await segmentFiles(dir)).length, 3);

    let page = await service.query('reclaim', { pageSize: 10 });
    assert.deepEqual(page.matches.map((m) => m.docId), ['a', 'b']);

    await service.reclaimOrphans();
    assert.equal((await segmentFiles(dir)).length, 1);

    service = await reopen(service, dir);
    page = await service.query('reclaim', { pageSize: 10 });
    assert.deepEqual(page.matches.map((m) => m.docId), ['a', 'b']);
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reference implementation agrees with snapshots across mixed revisions', async () => {
  const dir = await makeDir();
  try {
    const service = await DocumentService.open(dir, { flushThreshold: Infinity });
    const docs = {};
    const queries = [
      'red fox',
      '"red fox"',
      'fox -',
      '"lazy dog"',
      '123 abc',
    ];

    for (let i = 0; i < 12; i++) {
      const id = `id-${i}`;
      const text = i % 3 === 0
        ? 'red fox and lazy dog 123'
        : i % 3 === 1
          ? 'red fox only abc'
          : 'no relevant animals';
      await service.put(id, i, text);
      docs[id] = { rev: i, text };
      if (i === 4) await service.flush();
    }

    await service.put('id-1', 20, 'lazy dog only');
    docs['id-1'] = { rev: 20, text: 'lazy dog only' };
    await service.delete('id-3', 5);
    delete docs['id-3'];
    await service.flush();

    for (const query of queries) {
      const page = await service.query(query, { pageSize: 50 });
      expectSameAsReference(docs, query, page.matches);
    }
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('enforces the live document limit across tombstones and recreations', async () => {
  const dir = await makeDir();
  try {
    const service = await DocumentService.open(dir, {
      flushThreshold: Infinity,
      maxDocuments: 2,
    });
    await service.put('a', 0, 'limit word');
    await service.put('b', 0, 'limit word');
    await service.delete('a', 1);
    await service.put('c', 0, 'limit word');
    await assert.rejects(() => service.put('d', 0, 'limit word'), /document limit 2 reached/);

    const stats = await service.stats();
    assert.equal(stats.live, 2);
    assert.equal(stats.tombstones, 1);
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('expired cursors are rejected and their segments reclaimed', async () => {
  const dir = await makeDir();
  try {
    const service = await DocumentService.open(dir, {
      flushThreshold: Infinity,
      snapshotTtlMs: 1,
    });
    await service.put('a', 0, 'ttl word');
    await service.flush();
    await service.put('b', 0, 'ttl word');
    await service.flush();

    const first = await service.query('ttl', { pageSize: 1 });
    await service.merge();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await service.reclaimOrphans();
    await assert.rejects(
      () => service.query('ttl', { pageSize: 1, cursor: first.nextCursor }),
      /unknown or expired/,
    );
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
