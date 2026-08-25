'use strict';

const assert = require('node:assert');
const {
  githubPullRequestUrl,
  parseGitEnvironment,
  sourceLinksFromConversation,
} = require('../electron/project_environment');

const environment = parseGitEnvironment({
  root: 'C:\\work\\magic-pointer',
  branchOutput: '## codex/harness-reconstruction...origin/codex/harness-reconstruction [ahead 2]\n M electron/main.ts\n?? docs/new.md\n',
  numstatOutput: '101955\t21219\telectron/main.ts\n3\t0\tdocs/new.md\n-\t-\tassets/logo.png\n',
  remoteUrl: 'git@github.com:openai/codex.git',
});

assert.equal(environment.isGit, true);
assert.equal(environment.branch, 'codex/harness-reconstruction');
assert.equal(environment.upstream, 'origin/codex/harness-reconstruction');
assert.equal(environment.ahead, 2);
assert.equal(environment.behind, 0);
assert.equal(environment.changedFiles, 2);
assert.deepStrictEqual(environment.fileChanges, [
  { path: 'electron/main.ts', status: 'M', staged: false },
  { path: 'docs/new.md', status: '?', staged: false },
]);
assert.equal(environment.addedLines, 101958);
assert.equal(environment.deletedLines, 21219);
assert.equal(environment.remoteUrl, 'https://github.com/openai/codex');
assert.equal(environment.pullRequestUrl, 'https://github.com/openai/codex/compare/codex%2Fharness-reconstruction?expand=1');

assert.equal(
  githubPullRequestUrl('https://gitlab.com/example/repo.git', 'main'),
  '',
  'only a GitHub remote can expose the GitHub pull-request action',
);

assert.deepStrictEqual(sourceLinksFromConversation({
  turns: [
    { question: 'read https://sv-table.vercel.app/docs and https://sv-table.vercel.app/docs' },
    { answer: 'See https://openai.com/codex.' },
    { attachments: ['C:\\tmp\\note.md'] },
  ],
}), [
  'https://sv-table.vercel.app/docs',
  'https://openai.com/codex',
]);

console.log('project environment test ok');
