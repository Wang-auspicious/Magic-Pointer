import {parseXhsPage, type ResourcePost} from './resource_post';

export const COLLECTION_ACCOUNTS = [
  {
    id: 'xiaohongshu-1',
    platform: 'xiaohongshu',
    label: '小红书 1',
    url: 'https://www.xiaohongshu.com/',
  },
  {
    id: 'xiaohongshu-2',
    platform: 'xiaohongshu',
    label: '小红书 2',
    url: 'https://www.xiaohongshu.com/',
  },
  {id: 'x-1', platform: 'x', label: 'X', url: 'https://x.com/'},
  {id: 'web', platform: 'web', label: 'Web', url: 'https://www.minttr.com/'},
] as const;

export function collectionBrowserPartition(account: string): string {
  if (!COLLECTION_ACCOUNTS.some(item => item.id === account)) {
    throw new Error('Unknown collection browser account.');
  }
  return 'persist:magic-pointer-collection-' + account;
}

export interface CollectionPage {
  url: string;
  title: string;
  text: string;
  selectedText: string;
  author: string;
  handle: string;
  publishedAt: string;
  images: string[];
  videos: string[];
  links: string[];
  xhsData: string;
  error: string;
  truncated: boolean;
}

// Serialized into the website renderer; it reads only the current page.
export function readCollectionPage(): CollectionPage {
  const url = location.href;
  const title = document.title;
  const selectedText = window.getSelection()?.toString() || '';
  const body = document.body?.innerText || '';
  const result: CollectionPage = {
    url,
    title,
    selectedText,
    text: '',
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
  const verification =
    /安全验证|verify you are human|确认您是真人/i.test(title) ||
    (body.length < 1500 &&
      /安全验证|完成验证|verify you are human|unusual activity|确认您是真人/i.test(
        body,
      ));
  if (verification) {
    return {...result, error: 'verification_required'};
  }
  if (location.hostname.endsWith('xiaohongshu.com')) {
    const id =
      /\/(?:explore|search_result|note|discovery\/item|user\/profile\/[^/]+)\/([\da-f]+)(?:\/|$)/i.exec(
        location.pathname,
      )?.[1];
    const state = (
      window as unknown as {
        __INITIAL_STATE__?: {
          note?: {noteDetailMap?: Record<string, {note?: unknown}>};
        };
      }
    ).__INITIAL_STATE__;
    const raw = id ? state?.note?.noteDetailMap?.[id]?.note : undefined;
    if (raw && id) {
      result.xhsData = JSON.stringify({
        note: {noteDetailMap: {[id]: {note: raw}}},
      });
      return result;
    }
    if (!id) {
      return {
        ...result,
        error: /登录后|请登录|手机号登录/.test(body)
          ? 'auth_required'
          : 'post_unavailable',
      };
    }
    if (/登录后|请登录|手机号登录/.test(body)) {
      return {...result, error: 'auth_required'};
    }
    return {...result, error: 'post_loading'};
  }
  const xId = /\/status\/(\d+)/.exec(location.pathname)?.[1];
  let root: Element | null = null;
  if (xId && /(^|\.)(x|twitter)\.com$/.test(location.hostname)) {
    root =
      [...document.querySelectorAll('article[data-testid="tweet"]')].find(
        article =>
          [...article.querySelectorAll('a[href]')].some(
            link =>
              /\/status\/(\d+)$/.exec(
                new URL((link as HTMLAnchorElement).href).pathname,
              )?.[1] === xId && Boolean(link.querySelector('time')),
          ),
      ) || null;
    if (!root) {
      return {
        ...result,
        error: /log in|登录/i.test(body) ? 'auth_required' : 'post_loading',
      };
    }
    result.text =
      root.querySelector('[data-testid="tweetText"]')?.textContent || '';
    result.author =
      root.querySelector('[data-testid="User-Name"]')?.textContent || '';
    result.publishedAt =
      root.querySelector('time')?.getAttribute('datetime') || '';
  } else {
    root =
      document.querySelector('article') ||
      document.querySelector('main') ||
      document.body;
    result.text = (root as HTMLElement | null)?.innerText || '';
  }
  if (!root || !result.text.trim()) {
    return {...result, error: 'post_loading'};
  }
  result.truncated = result.text.length > 200000;
  result.text = result.text.slice(0, 200000);
  result.images = [
    ...new Set(
      [
        ...root.querySelectorAll<HTMLImageElement>(
          xId ? '[data-testid="tweetPhoto"] img' : 'img',
        ),
      ]
        .map(image => image.currentSrc || image.src)
        .filter(value => /^https?:/.test(value)),
    ),
  ];
  result.videos = [
    ...new Set(
      [...root.querySelectorAll<HTMLVideoElement>('video')]
        .map(video => video.currentSrc || video.src)
        .filter(value => /^https?:/.test(value)),
    ),
  ];
  result.links = [
    ...new Set(
      [...root.querySelectorAll<HTMLAnchorElement>('a[href]')]
        .map(link => link.href)
        .filter(value => /^https?:/.test(value)),
    ),
  ];
  return result;
}

export function postFromCollectionPage(page: CollectionPage): ResourcePost {
  if (page.error) {
    throw new Error(page.error);
  }
  if (page.xhsData) {
    return {
      ...parseXhsPage(
        page.url,
        `<script>window.__INITIAL_STATE__=${page.xhsData}</script>`,
      ),
      usedBackend: 'mp.embedded_browser.xiaohongshu',
    };
  }
  const xId = /\/status\/(\d+)/.exec(new URL(page.url).pathname)?.[1];
  return {
    platform: xId ? 'x' : 'web',
    id: xId || page.url,
    url: page.url,
    title: page.title,
    text: page.text,
    author: {name: page.author, handle: page.handle},
    publishedAt: Date.parse(page.publishedAt) || undefined,
    capturedAt: Date.now(),
    media: [
      ...page.images.map(url => ({kind: 'image' as const, url})),
      ...page.videos.map(url => ({kind: 'video' as const, url})),
    ],
    links: page.links,
    coverage: `${page.truncated ? 'First 200000 characters' : 'Rendered page text'} and available web images. ${xId ? 'Replies and linked articles were not read. Video streams not exposed as downloadable URLs are not retained.' : 'Navigation, interactive states and media not loaded by this page may be absent.'}`,
    usedBackend: 'mp.embedded_browser.dom',
    timingMs: 0,
  };
}
