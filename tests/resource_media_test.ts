import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {prepareResourceMedia} from '../electron/resource_media';

test('a local demo supplies actual timestamped frames and declares the unsampled video and audio', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-video-'));
  const video = join(root, 'demo.mp4');
  execFileSync(
    'ffmpeg',
    [
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=160x90:d=3',
      '-c:v',
      'mpeg4',
      video,
    ],
    {windowsHide: true},
  );
  const evidence = await prepareResourceMedia(video);
  assert.ok(evidence.attachments.length >= 3);
  assert.match(
    readFileSync(evidence.attachments[0], 'utf8'),
    /audio.*not.*transcribed/i,
  );
  for (const frame of evidence.attachments.slice(1)) {
    assert.deepEqual([...readFileSync(frame).subarray(1, 4)], [80, 78, 71]);
  }
});
