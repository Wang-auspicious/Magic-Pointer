import {
  parseXhsPage,
  postPlatform,
  socialPostIdentity,
  type ResourcePost,
} from './resource_post';
import type {HistoryPage} from './resource_browser_history';

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
  const challenge = document.querySelector(
    'iframe[src*="captcha"],[class*="captcha-container"]',
  );
  const verification =
    /(?:^|[-|])\s*(?:安全验证|人机验证|verify you are human|确认您是真人)\s*$/i.test(
      title,
    ) ||
    Boolean(
      challenge &&
      [...challenge.getClientRects()].some(
        rect => rect.width > 0 && rect.height > 0,
      ) &&
      getComputedStyle(challenge).visibility !== 'hidden',
    );
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

export function postFromCollectionPage(
  page: CollectionPage,
  sourceUrl = page.url,
): ResourcePost {
  if (page.error) {
    throw new Error(page.error);
  }
  const xId =
    postPlatform(page.url) === 'x'
      ? /\/status\/(\d+)/.exec(new URL(page.url).pathname)?.[1]
      : undefined;
  const post: ResourcePost = page.xhsData
    ? {
        ...parseXhsPage(
          page.url,
          `<script>window.__INITIAL_STATE__=${page.xhsData}</script>`,
        ),
        usedBackend: 'mp.embedded_browser.xiaohongshu',
      }
    : {
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
  const sourcePlatform = postPlatform(sourceUrl);
  const identity = socialPostIdentity(sourceUrl);
  if (
    sourcePlatform !== 'web' &&
    (post.platform !== sourcePlatform ||
      (identity !== sourceUrl && identity !== `${post.platform}:${post.id}`))
  ) {
    throw new Error(
      'post_unavailable: The share link did not expose the requested original post. Open that individual post in the MP browser, then retry.',
    );
  }
  return post;
}

export function readXhsAccountIdentity(): {id: string; name: string} | null {
  const state = (
    window as unknown as {
      __INITIAL_STATE__?: {
        user?: {
          userInfo?: Record<string, unknown>;
          loggedIn?: boolean | {_value?: boolean};
        };
      };
    }
  ).__INITIAL_STATE__;
  const loggedIn = state?.user?.loggedIn;
  if ((typeof loggedIn === 'object' ? loggedIn?._value : loggedIn) === false) {
    return null;
  }
  const user = state?.user?.userInfo;
  const info = (user?._value || user) as Record<string, unknown> | undefined;
  const id = String(info?.user_id || info?.userId || info?.userID || '');
  return id
    ? {id, name: String(info?.nickname || info?.nickName || info?.name || '')}
    : null;
}

export function readXhsAccountId(): string {
  const state = (
    window as unknown as {
      __INITIAL_STATE__?: {
        user?: {
          userInfo?: {
            user_id?: string;
            userId?: string;
            userID?: string;
            _value?: {user_id?: string; userId?: string; userID?: string};
          };
        };
      };
    }
  ).__INITIAL_STATE__;
  const user = state?.user?.userInfo;
  const info = user?._value || user;
  return String(info?.user_id || info?.userId || info?.userID || '');
}

// Uses the user's normal rendered list; no signing, cookie export or private API.
export function readXhsHistoryPage(): HistoryPage {
  const body = document.body?.innerText || '';
  const result: HistoryPage = {
    url: location.href,
    links: [],
    atEnd: false,
    error: '',
    coverage:
      'Notes exposed by the current account list; original captures have their own download status.',
    position: 0,
  };
  const challenge = document.querySelector(
    'iframe[src*="captcha"],[class*="captcha-container"]',
  );
  if (
    /(?:^|[-|])\s*(?:安全验证|人机验证|verify you are human|确认您是真人)\s*$/i.test(
      document.title,
    ) ||
    (challenge &&
      [...challenge.getClientRects()].some(
        rect => rect.width > 0 && rect.height > 0,
      ) &&
      getComputedStyle(challenge).visibility !== 'hidden')
  ) {
    return {...result, error: 'verification_required'};
  }
  if (/登录后查看|登录后可查看|请先登录|手机号登录/.test(body)) {
    return {...result, error: 'auth_required'};
  }
  const cards = [
    ...document.querySelectorAll<HTMLElement>('section.note-item'),
  ].filter(
    card =>
      !card.classList.contains('query-note-item') &&
      card.getClientRects().length > 0,
  );
  for (const card of cards) {
    const anchor =
      card.querySelector<HTMLAnchorElement>('a.cover.mask[href]') ||
      [...card.querySelectorAll<HTMLAnchorElement>('a[href]')].find(link =>
        /\/(?:explore|search_result|note|discovery\/item|user\/profile\/[^/]+)\/[\da-f]+(?:\?|$)/i.test(
          link.href,
        ),
      );
    if (!anchor) {
      continue;
    }
    const url = new URL(anchor.href, location.origin);
    const id =
      /\/(?:explore|search_result|note|discovery\/item|user\/profile\/[^/]+)\/([\da-f]+)(?:\/|$)/i.exec(
        url.pathname,
      )?.[1];
    if (
      id &&
      url.hostname.endsWith('xiaohongshu.com') &&
      !result.links.some(link => link.id === id)
    ) {
      result.links.push({
        id,
        url: url.href,
        title: card.querySelector('.title')?.textContent?.trim() || '',
      });
    }
  }
  let scroller: Element | null =
    cards[0]?.parentElement || document.scrollingElement;
  while (
    scroller?.parentElement &&
    scroller.scrollHeight <= scroller.clientHeight + 2
  ) {
    scroller = scroller.parentElement;
  }
  result.position = (scroller?.scrollTop || 0) + (scroller?.scrollHeight || 0);
  result.atEnd = [
    ...(scroller || document.body).querySelectorAll<HTMLElement>('p,div,span'),
  ].some(
    element =>
      !element.closest('section.note-item') &&
      element.getClientRects().length > 0 &&
      /^(?:没有更多(?:了)?[~～。！!]?|已经到底(?:了)?[~～。！!]?|暂时没有收藏|还没有收藏|你还没有收藏任何内容哦|暂无收藏|暂无点赞|还没有赞过|暂无笔记)$/.test(
        element.innerText.trim(),
      ),
  );
  return result;
}

export function advanceXhsHistoryPage(): void {
  let scroller: Element | null =
    document.querySelector('section.note-item:not(.query-note-item)')
      ?.parentElement || document.scrollingElement;
  while (
    scroller?.parentElement &&
    scroller.scrollHeight <= scroller.clientHeight + 2
  ) {
    scroller = scroller.parentElement;
  }
  scroller?.scrollTo({top: scroller.scrollHeight, behavior: 'instant'});
}
