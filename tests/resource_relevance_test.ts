import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resourceCollection,
  type CollectedResource,
} from '../electron/resource_collection_contract';
import {
  prioritizeResources,
  chronologicalResources,
} from '../electron/resource_relevance';

const item = (id: string, title: string, time: number): CollectedResource => ({
  id,
  media: 'text',
  capturedAt: time,
  relPath: '',
  collection: resourceCollection({title}),
});

test('current work brings a forgotten relevant reference ahead of a new unrelated bookmark and explains why', () => {
  const old = item('old', 'SQLite 数据库损坏与后台监控恢复', 1);
  const fresh = item('fresh', '周末露营路线', Date.now());
  const sorted = prioritizeResources(
    [fresh, old],
    '修复 SQLite 数据库损坏，恢复后台监控',
  );
  assert.equal(sorted[0].id, 'old');
  assert.ok(sorted[0].relevanceReason?.includes('SQLite'));
});

test('history order follows the observed saved list, while new hourly imports come before the initial batch', () => {
  const newest = item('newest', '', 100);
  newest.collection = resourceCollection({
    bookmarkBatch: 200,
    bookmarkPosition: 0,
  });
  const first = item('first', '', 110);
  first.collection = resourceCollection({
    bookmarkBatch: 100,
    bookmarkPosition: 0,
  });
  const last = item('last', '', 120);
  last.collection = resourceCollection({
    bookmarkBatch: 100,
    bookmarkPosition: 1,
  });
  assert.deepEqual(
    chronologicalResources([last, first, newest]).map(value => value.id),
    ['newest', 'first', 'last'],
  );
});
