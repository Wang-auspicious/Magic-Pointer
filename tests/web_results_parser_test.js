'use strict';

// Feeds the shape MP's Search tool actually returns today
// (agent_services.ts registerWebTools -> {ok, results:[{title,url,snippet}]})
// plus the richer fields the reference payload would carry, and asserts the
// renderer's parser reads them instead of silently producing nothing.
const assert = require('node:assert/strict');

global.document = undefined;
const ChatView = require('../electron/renderer/chat_view');
const {webResults, webCountLabel} = ChatView.__test;

const live = webResults('Search', {
  ok: true,
  results: [
    {title: 'Fat-tailed dwarf lemur', url: 'https://example.org/a', snippet: 'one'},
    {title: 'Cheirogaleus medius', url: 'https://www.example.com/b', snippet: 'two'},
    {title: 'Lemur facts', url: 'https://facts.example.net/c', snippet: 'three'},
  ],
});
assert.equal(live.count, 3, 'three search results are counted');
assert.equal(live.sources.length, 3, 'three sources parse');
assert.equal(live.sources[0].url, 'https://example.org/a', 'source urls survive');
assert.equal(live.images.length, 0, 'no images in a live payload means no tiles');
assert.equal(webCountLabel(3), '3 results');

const media = webResults('web_search', {
  query: 'furty-eared dwarf lemur',
  images: [
    {image_url: 'https://img.example.org/1.jpg', source: 'lemurfaction'},
    {image_url: 'https://img.example.org/2.jpg', page_url: 'https://vibe.2maarten/x'},
  ],
  results: [{title: 'A', url: 'https://a.example.org'}],
});
assert.equal(media.images.length, 2, 'image payloads parse');
assert.equal(media.images[0].source, 'lemurfaction', 'credit label survives');
assert.equal(media.sources.length, 1, 'sources still parse next to images');

assert.equal(webResults('Search', {ok: true, results: []}).count, 0);
assert.equal(webResults('read', {results: []}), null, 'non-search tools do not claim results');
assert.equal(webResults('Search', null), null, 'no payload means no card');

console.log('web results parser: ok');
