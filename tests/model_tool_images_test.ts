import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {modelPayload, type ModelMessage} from '../electron/runtime/model';
import {extractToolImages} from '../electron/runtime/agent_services';
import sharp from 'sharp';
import {DocumentReader} from '../electron/runtime/context_documents';
import {fileSource} from '../electron/runtime/context';

const dir = mkdtempSync(join(tmpdir(), 'mp-tool-images-'));
const png = (name: string) => {
  const path = join(dir, name);
  writeFileSync(path, Buffer.from('89504e470d0a1a0a', 'hex'));
  return path;
};
const call = (id: string) => ({
  role: 'assistant' as const,
  content: null,
  tool_calls: [{id, name: 'get_app_state', arguments: {}}],
});
const tool = (id: string, image?: string): ModelMessage => ({
  role: 'tool',
  tool_call_id: id,
  name: 'get_app_state',
  content: '{"ok":true}',
  ...(image
    ? {images: [{path: image, mimeType: 'image/png', label: `screen ${id}`}]}
    : {}),
});
const history: ModelMessage[] = [
  {role: 'user', content: 'open the menu'},
  call('a'),
  tool('a', png('a.png')),
  call('b'),
  tool('b', png('b.png')),
  call('c'),
  tool('c', png('c.png')),
];

test('a bound image source delivers its full oriented pixels through the existing model image channel', async () => {
  const file = join(dir, 'project-photo.jpg');
  await sharp({
    create: {width: 24, height: 12, channels: 3, background: '#2476bf'},
  })
    .jpeg()
    .withMetadata({orientation: 6})
    .toFile(file);
  const source = fileSource('image-task', file);
  const reader = new DocumentReader();
  const result = await reader.read(source);
  assert.equal(
    result.evidenceStatus,
    'ok',
    'uploaded project images must not be unsupported document types',
  );
  assert.equal(result.coverage.complete, true);
  const extracted = await extractToolImages(
    result,
    join(dir, 'source-images'),
    'source-image',
  );
  assert.equal(extracted.images.length, 1);
  const info = await sharp(extracted.images[0].path).metadata();
  assert.equal(info.width, 12);
  assert.equal(info.height, 24);
  const body = modelPayload(
    {model: 'deepseek-v4.1-flash', apiMode: 'chat-completions'} as never,
    {
      system: 's',
      tools: [],
      messages: [
        {role: 'user', content: 'Read the project image'},
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'source-image',
              name: 'Context.read',
              arguments: {source_id: source.sourceId},
            },
          ],
        },
        {
          role: 'tool',
          name: 'Context.read',
          tool_call_id: 'source-image',
          content: JSON.stringify(extracted.value),
          images: extracted.images,
        },
      ],
    },
  );
  assert.ok(
    body.messages
      .at(-1)
      .content.some((part: {type: string}) => part.type === 'image_url'),
  );
  const search = await reader.read(source, {query: 'invoice'});
  assert.equal(search.evidenceStatus, 'unsupported');
  assert.match(search.coverage.missingReason || '', /visual.*read/i);
});

test('Anthropic tool results carry the newest screenshots as image blocks', () => {
  const body = modelPayload(
    {model: 'claude-sonnet-5', apiMode: 'messages'} as never,
    {system: 's', messages: history, tools: []},
  );
  const results = body.messages
    .flatMap((message: {content: {type: string}[]}) => message.content)
    .filter((block: {type: string}) => block.type === 'tool_result');
  assert.equal(results.length, 3);
  assert.equal(
    typeof results[0].content,
    'string',
    'the oldest screenshot is dropped from the request',
  );
  assert.match(results[0].content, /earlier screenshot omitted/);
  for (const result of results.slice(1)) {
    assert.ok(Array.isArray(result.content));
    assert.equal(
      result.content.find((block: {type: string}) => block.type === 'image')
        .source.media_type,
      'image/png',
    );
  }
});

test('animated image sources expose each frame through an explicit continuation', async () => {
  const file = join(dir, 'two-frames.gif');
  const raw = Buffer.from([
    ...Array.from({length: 4}, () => [255, 0, 0]).flat(),
    ...Array.from({length: 4}, () => [0, 0, 255]).flat(),
  ]);
  await sharp(raw, {raw: {width: 2, height: 4, channels: 3, pageHeight: 2}})
    .gif({delay: [100, 100]})
    .toFile(file);
  const source = fileSource('animated-task', file);
  const reader = new DocumentReader();
  const first = await reader.read(source);
  assert.equal(first.coverage.totalUnits, 2);
  assert.equal(first.coverage.complete, false);
  assert.equal(first.coverage.nextCursor, 'frame:1');
  const second = await reader.read(source, {cursor: first.coverage.nextCursor});
  assert.equal(second.coverage.complete, true);
  assert.equal(second.coverage.nextCursor, null);
  const pixels = await sharp(Buffer.from(second.image!, 'base64'))
    .removeAlpha()
    .raw()
    .toBuffer();
  assert.deepEqual([...pixels.subarray(0, 3)], [0, 0, 255]);
  await assert.rejects(
    () => reader.read(source, {cursor: 'frame:2'}),
    /frame must be between/,
  );
});

test('chat-completions sends screenshots in a user message after the tool batch', () => {
  const body = modelPayload(
    {model: 'deepseek-v4.1-flash', apiMode: 'chat-completions'} as never,
    {system: 's', messages: history, tools: []},
  );
  const roles = body.messages.map((message: {role: string}) => message.role);
  assert.deepEqual(roles, [
    'system',
    'user',
    'assistant',
    'tool',
    'assistant',
    'tool',
    'user',
    'assistant',
    'tool',
    'user',
  ]);
  const last = body.messages.at(-1);
  assert.equal(
    last.content
      .find((part: {type: string}) => part.type === 'image_url')
      .image_url.url.slice(0, 22),
    'data:image/png;base64,',
  );
});

test('tool values with inline screenshots are persisted and replaced by a reference', async () => {
  const value = {
    ok: true,
    image: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'),
    mimeType: 'image/png',
    imageLabel: 'Notepad',
  };
  const extracted = await extractToolImages(
    value,
    join(dir, 'store'),
    'call-1',
  );
  assert.equal(extracted.images.length, 1);
  assert.equal((extracted.value as Record<string, unknown>).image, undefined);
  assert.match(
    String((extracted.value as Record<string, unknown>).imageAttached),
    /call-1-0\.png$/,
  );
  assert.equal(extracted.images[0].label, 'Notepad');
  const plain = await extractToolImages(
    {ok: true},
    join(dir, 'store'),
    'call-2',
  );
  assert.deepEqual(plain.images, []);
});
