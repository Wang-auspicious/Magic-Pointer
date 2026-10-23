import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {
  postFromCollectionPage,
  type CollectionPage,
} from '../electron/collection_browser';

const source = ts.createSourceFile(
  'collection_browser.ts',
  readFileSync('electron/collection_browser.ts', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const declaration = source.statements.find(
  node =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'readCollectionPage',
)!;
const script =
  ts.transpile(declaration.getText(source).replace(/^export\s+/, ''), {
    target: ts.ScriptTarget.ES2022,
  }) + ';readCollectionPage()';

test('a note about verification is still a note; a real challenge is a gate', () => {
  const context = {
    URL,
    location: {
      href: 'https://www.xiaohongshu.com/explore/abc123',
      hostname: 'www.xiaohongshu.com',
      pathname: '/explore/abc123',
    },
    window: {
      getSelection: () => null,
      __INITIAL_STATE__: {
        note: {
          noteDetailMap: {
            abc123: {
              note: {
                noteId: 'abc123',
                title: '安全验证界面设计',
                desc: '怎样设计一个验证码输入页面',
              },
            },
          },
        },
      },
    },
    document: {
      title: '安全验证界面设计 - 小红书',
      body: {innerText: '安全验证界面设计'},
      querySelector: () => null,
    },
  };
  const result = runInNewContext(script, context);
  assert.equal(result.error, '');
  assert.match(result.xhsData, /怎样设计/);
  const gated = runInNewContext(script, {
    ...context,
    window: {getSelection: () => null},
    document: {...context.document, title: '小红书 - 安全验证'},
  });
  assert.equal(gated.error, 'verification_required');
  const visibleChallenge = runInNewContext(script, {
    ...context,
    getComputedStyle: () => ({visibility: 'visible'}),
    document: {
      ...context.document,
      querySelector: () => ({
        getClientRects: () => [{width: 300, height: 200}],
      }),
    },
  });
  assert.equal(
    visibleChallenge.error,
    'verification_required',
    'a visible challenge stops capture even when old note data is still present',
  );
  const hiddenChallenge = runInNewContext(script, {
    ...context,
    document: {
      ...context.document,
      querySelector: () => ({getClientRects: () => []}),
    },
  });
  assert.equal(
    hiddenChallenge.error,
    '',
    'an inactive challenge widget does not block a readable note',
  );
});

function page(url: string): CollectionPage {
  return {
    url,
    title: 'A page',
    text: 'Open the app to continue',
    selectedText: '',
    author: '',
    handle: '',
    publishedAt: '',
    images: [],
    videos: [],
    links: [],
    xhsData: '',
    error: '',
    truncated: false,
  };
}

test('a social share landing page or redirected different note cannot be saved as the requested original', () => {
  assert.throws(
    () => postFromCollectionPage(page('https://xhslink.com/o/share')),
    /post_unavailable/,
  );
  const note = {
    ...page('https://www.xiaohongshu.com/explore/abc123'),
    xhsData: JSON.stringify({
      note: {
        noteDetailMap: {
          abc123: {note: {noteId: 'abc123', desc: 'The actual note'}},
        },
      },
    }),
  };
  assert.throws(
    () =>
      postFromCollectionPage(
        note,
        'https://www.xiaohongshu.com/explore/def456',
      ),
    /post_unavailable/,
  );
  assert.equal(
    postFromCollectionPage(note, 'https://xhslink.com/o/share').id,
    'abc123',
  );
});

test('a numeric status path on an ordinary website remains a web page', () => {
  assert.equal(
    postFromCollectionPage(page('https://example.com/status/123456')).platform,
    'web',
  );
});
