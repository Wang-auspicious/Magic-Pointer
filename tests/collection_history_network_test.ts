import test from 'node:test';
import assert from 'node:assert/strict';
import {readHistoryResponse} from '../electron/collection_history_network';

test('the account list response proves its end and preserves signed note URLs without a visible footer', () => {
  const result = readHistoryResponse({
    success: true,
    data: {
      has_more: false,
      notes: [
        {
          note_id: 'abc123',
          xsec_token: 'keep-this-token',
          display_title: '收藏原帖',
          user: {user_id: 'author'},
        },
      ],
    },
  });
  assert.equal(result?.atEnd, true);
  assert.equal(result?.links[0].id, 'abc123');
  assert.ok(result?.links[0].url.includes('xsec_token=keep-this-token'));
  assert.equal(
    readHistoryResponse({success: false, data: {notes: [], has_more: false}}),
    null,
  );
  assert.equal(readHistoryResponse({data: {notes: []}})?.atEnd, false);
});
