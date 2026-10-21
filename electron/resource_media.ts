import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, writeFile} from 'node:fs/promises';
import {extname} from 'node:path';

const execute = promisify(execFile);
export async function prepareResourceMedia(
  file: string,
): Promise<{attachments: string[]; coverage: string}> {
  if (
    !['.mp4', '.mov', '.webm', '.mkv', '.avi'].includes(
      extname(file).toLowerCase(),
    )
  ) {
    return {attachments: [file], coverage: ''};
  }
  try {
    const probe = await execute(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file],
      {windowsHide: true, timeout: 20000},
    );
    const duration = Number(JSON.parse(probe.stdout).format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('Video duration is unavailable.');
    }
    const folder = file + '.frames';
    await mkdir(folder, {recursive: true});
    const moments = Array.from({length: 6}, (_, index) =>
      Math.min(duration - 0.05, (duration * index) / 6),
    );
    const frames: string[] = [];
    for (const [index, time] of moments.entries()) {
      const frame = `${folder}/frame-${index + 1}.png`;
      await execute(
        'ffmpeg',
        [
          '-loglevel',
          'error',
          '-y',
          '-ss',
          String(Math.max(0, time)),
          '-i',
          file,
          '-frames:v',
          '1',
          '-vf',
          'scale=1280:1280:force_original_aspect_ratio=decrease',
          frame,
        ],
        {windowsHide: true, timeout: 30000},
      );
      frames.push(frame);
    }
    const coverage = `Video duration ${duration.toFixed(2)} seconds. Six sampled frames only; motion between frames has not been observed. Audio has not been transcribed. Do not claim complete video understanding or exact animation timing.`;
    const indexFile = `${folder}/frames.txt`;
    await writeFile(
      indexFile,
      [
        coverage,
        ...frames.map(
          (frame, index) => `${moments[index].toFixed(2)} s: ${frame}`,
        ),
      ].join('\n'),
      'utf8',
    );
    return {attachments: [indexFile, ...frames], coverage};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        'Video processing requires ffmpeg and ffprobe on this computer. The original video is retained.',
      );
    }
    throw error;
  }
}
