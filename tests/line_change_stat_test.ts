import assert from 'node:assert/strict';
import test from 'node:test';
import {lineChangeStat} from '../electron/line_change_stat';

test('line statistics preserve blank lines, final newline and actual line endings', () => {
  assert.deepEqual(lineChangeStat('', '\n'), {added: 1, removed: 0});
  assert.deepEqual(lineChangeStat('a\n', 'a'), {added: 1, removed: 1});
  assert.deepEqual(lineChangeStat('a\r\nb\r\n', 'a\nb\n'), {
    added: 2,
    removed: 2,
  });
  assert.deepEqual(lineChangeStat('a\nb\nc\n', 'b\nc changed\n'), {
    added: 1,
    removed: 2,
  });
});

test('short duplicate-line cases agree with an independent longest-common-subsequence calculation', () => {
  const values: string[][] = [[]];
  for (let length = 1; length <= 4; length++) {
    for (let mask = 0; mask < 2 ** length; mask++)
      values.push(
        Array.from({length}, (_, i) => (mask & (1 << i) ? 'A\n' : 'B\n')),
      );
  }
  for (const before of values)
    for (const after of values) {
      const table = Array.from({length: before.length + 1}, () =>
        Array(after.length + 1).fill(0),
      );
      for (let i = 1; i <= before.length; i++)
        for (let j = 1; j <= after.length; j++) {
          table[i][j] =
            before[i - 1] === after[j - 1]
              ? table[i - 1][j - 1] + 1
              : Math.max(table[i - 1][j], table[i][j - 1]);
        }
      const common = table[before.length][after.length];
      assert.deepEqual(lineChangeStat(before.join(''), after.join('')), {
        added: after.length - common,
        removed: before.length - common,
      });
    }
});

test('large reversed input stops optional calculation while disjoint replacement remains exact', () => {
  const values = Array.from({length: 2000}, (_, i) => `line ${i}\n`);
  assert.equal(
    lineChangeStat(values.join(''), [...values].reverse().join('')),
    null,
  );
  assert.deepEqual(
    lineChangeStat(values.join(''), values.map(v => 'new ' + v).join('')),
    {added: 2000, removed: 2000},
  );
});
