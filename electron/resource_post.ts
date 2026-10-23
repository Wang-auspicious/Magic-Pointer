export type ResourcePlatform = 'x' | 'xiaohongshu' | 'web';

export interface PostMedia {
  kind: 'image' | 'video' | 'audio';
  url: string;
  width?: number;
  height?: number;
  localPath?: string;
  localUrl?: string;
  error?: string;
  bytes?: number;
}

export interface ResourcePost {
  platform: ResourcePlatform;
  id: string;
  url: string;
  title: string;
  text: string;
  author: {name: string; handle?: string; url?: string};
  publishedAt?: number;
  capturedAt: number;
  media: PostMedia[];
  links: string[];
  coverage: string;
  usedBackend: string;
  timingMs: number;
}

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function parseSharedLinks(input: string): string[] {
  const matches =
    input.match(/https?:\/\/[^\s<>"'，。！？；、（）【】]+/g) || [];
  return [
    ...new Set(
      matches
        .map(value => value.replace(/[),.;!?]+$/, ''))
        .filter(value => {
          try {
            return Boolean(new URL(value).hostname);
          } catch {
            return false;
          }
        }),
    ),
  ];
}

export function postPlatform(url: string): ResourcePlatform {
  const host = new URL(url).hostname.toLowerCase();
  if (
    [
      'x.com',
      'www.x.com',
      'twitter.com',
      'www.twitter.com',
      'mobile.twitter.com',
    ].includes(host)
  ) {
    return 'x';
  }
  if (
    host === 'xiaohongshu.com' ||
    host.endsWith('.xiaohongshu.com') ||
    host === 'xhslink.com' ||
    host.endsWith('.xhslink.com')
  ) {
    return 'xiaohongshu';
  }
  return 'web';
}

// Hydration contains JSON with bare undefined values. Read it as data, never eval.
function hydration(html: string): Record<string, unknown> {
  const marker = /window\.__INITIAL_STATE__\s*=\s*/g.exec(html);
  if (!marker) {
    return {};
  }
  let quoted = false;
  let escaped = false;
  let depth = 0;
  let json = '';
  for (
    let index = marker.index + marker[0].length;
    index < html.length;
    index++
  ) {
    const char = html[index];
    if (quoted) {
      json += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        quoted = false;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === '{' || char === '[') {
      depth++;
    } else if (char === '}' || char === ']') {
      depth--;
    } else if (html.slice(index, index + 9) === 'undefined') {
      json += 'null';
      index += 8;
      continue;
    }
    json += char;
    if (depth === 0 && json.trim()) {
      return object(JSON.parse(json));
    }
  }
  return {};
}

function mediaUrl(value: unknown): string {
  const url = text(value);
  return /^https?:\/\//.test(url) ? url : '';
}

export function parseXhsPage(url: string, html: string): ResourcePost {
  const id =
    /\/(?:explore|search_result|note|discovery\/item|user\/profile\/[^/]+)\/([\da-f]+)(?:\/|$)/i.exec(
      new URL(url).pathname,
    )?.[1];
  if (!id) {
    throw new Error(
      'post_unavailable: A complete Xiaohongshu note link is required.',
    );
  }
  const state = hydration(html);
  const note = object(
    object(object(object(state.note).noteDetailMap)[id]).note,
  );
  if (
    (!text(note.desc) && !text(note.title)) ||
    (note.noteId && note.noteId !== id)
  ) {
    if (/安全验证|验证码|captcha/i.test(html)) {
      throw new Error(
        'verification_required: Complete the verification in your browser. Collection has stopped.',
      );
    }
    if (/请登录|登录后|login required/i.test(html)) {
      throw new Error(
        'auth_required: Sign in to Xiaohongshu in the collection browser.',
      );
    }
    throw new Error(
      'post_unavailable: The requested note was not exposed by this page.',
    );
  }
  const user = object(note.user);
  const media: PostMedia[] = [];
  for (const raw of Array.isArray(note.imageList) ? note.imageList : []) {
    const image = object(raw);
    const imageUrl = mediaUrl(image.urlDefault) || mediaUrl(image.urlPre);
    if (imageUrl) {
      media.push({
        kind: 'image',
        url: imageUrl,
        width: Number(image.width) || undefined,
        height: Number(image.height) || undefined,
      });
    }
  }
  const streams = object(object(object(note.video).media).stream);
  const candidates = Object.values(streams)
    .flatMap(value => (Array.isArray(value) ? value : []))
    .map(object);
  const video = candidates
    .filter(value => mediaUrl(value.masterUrl))
    .sort(
      (left, right) => Number(right.width || 0) - Number(left.width || 0),
    )[0];
  if (video) {
    media.push({
      kind: 'video',
      url: String(video.masterUrl),
      width: Number(video.width) || undefined,
      height: Number(video.height) || undefined,
    });
  }
  return {
    platform: 'xiaohongshu',
    id,
    url,
    title: text(note.title) || text(note.desc).slice(0, 100),
    text: text(note.desc),
    author: {
      name: text(user.nickname),
      handle: text(user.userId),
      url: user.userId
        ? `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(String(user.userId))}`
        : undefined,
    },
    publishedAt: Number(note.time) || undefined,
    capturedAt: Date.now(),
    media,
    links: parseSharedLinks(text(note.desc)),
    coverage:
      'Full note text and ordered media exposed by this page. Comments and unavailable attachments are not included. Media are the available web representations.',
    usedBackend: 'xiaohongshu.page_hydration',
    timingMs: 0,
  };
}

export function parseXPost(url: string, raw: unknown): ResourcePost {
  const value = object(raw);
  const id = /\/status\/(\d+)/.exec(new URL(url).pathname)?.[1];
  if (!id) {
    throw new Error('post_unavailable: An individual X post link is required.');
  }
  const body =
    text(value.description) || text(value.full_text) || text(value.text);
  if (!body) {
    throw new Error('post_unavailable: X did not expose post text.');
  }
  const entries = Array.isArray(value.entries) ? value.entries : [value];
  const media: PostMedia[] = [];
  for (const entry of entries.map(object)) {
    const formats = Array.isArray(entry.formats)
      ? entry.formats.map(object)
      : [];
    const best = formats
      .filter(
        format =>
          mediaUrl(format.url) &&
          format.vcodec !== 'none' &&
          /\.mp4(?:\?|$)/.test(String(format.url)),
      )
      .at(-1);
    const videoUrl = mediaUrl(entry.url) || mediaUrl(best?.url);
    if (videoUrl && /\.(?:mp4|webm)(?:\?|$)/i.test(videoUrl)) {
      media.push({
        kind: 'video',
        url: videoUrl,
        width: Number(entry.width || best?.width) || undefined,
        height: Number(entry.height || best?.height) || undefined,
      });
    }
  }
  for (const entry of Array.isArray(value.images) ? value.images : []) {
    const image = typeof entry === 'string' ? entry : object(entry).url;
    if (mediaUrl(image)) {
      media.push({kind: 'image', url: String(image)});
    }
  }
  return {
    platform: 'x',
    id,
    url,
    title: body.slice(0, 100),
    text: body,
    author: {
      name: text(value.uploader) || text(value.author),
      handle: text(value.uploader_id),
    },
    publishedAt: Number(value.timestamp)
      ? Number(value.timestamp) * 1000
      : undefined,
    capturedAt: Date.now(),
    media,
    links: parseSharedLinks(body),
    coverage:
      'Post text and available media returned by the source. Replies and linked articles are not included.',
    usedBackend: 'yt-dlp.metadata',
    timingMs: 0,
  };
}
