import { type CapturedPost, safeImage } from './model';

const STATUS = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})(?:\/|$)/;
export function statusLink(article: Element): HTMLAnchorElement | null {
  // The primary timestamp precedes quoted content; ignore the quote's timestamp.
  for (const time of article.querySelectorAll('time')) {
    const link = time.closest<HTMLAnchorElement>('a[href]');
    if (link && STATUS.test(link.pathname) && !time.closest('[data-testid="quoteTweet"]')) return link;
  }
  return null;
}
export function extractPost(article: Element, excludePromoted = true): CapturedPost | null {
  if (excludePromoted && (article.querySelector('[data-testid="placementTracking"], [data-testid="promotedIndicator"]') || [...article.querySelectorAll('[data-testid="socialContext"], [data-testid="AdTag"]')].some(el => /\bAd\b|Promoted|推广|廣告|广告/i.test(el.textContent ?? '')))) return null;
  const link = statusLink(article); if (!link) return null;
  const match = link.pathname.match(STATUS)!;
  const authorHandle = match[1];
  const nameBox = article.querySelector('[data-testid="User-Name"]');
  const nameLink = [...(nameBox?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? [])].find(a => a.pathname.toLowerCase() === `/${authorHandle.toLowerCase()}` && !a.textContent?.startsWith('@'));
  const authorName = (nameLink?.textContent || nameBox?.querySelector('span')?.textContent || authorHandle).trim();
  const texts = [...article.querySelectorAll<HTMLElement>('[data-testid="tweetText"]')];
  const mainText = texts.find(el => !el.closest('[data-testid="quoteTweet"]'));
  // X sometimes has no quoteTweet testid; remaining tweetText nodes still belong in quotedText.
  const textOf = (node: Element) => {
    const clone = node.cloneNode(true) as Element;
    for (const img of clone.querySelectorAll('img[alt]')) img.replaceWith(img.getAttribute('alt') ?? '');
    for (const br of clone.querySelectorAll('br')) br.replaceWith('\n');
    return (clone.textContent ?? '').trim();
  };
  const images = [...article.querySelectorAll<HTMLImageElement>('[data-testid="tweetPhoto"] img')].map(i => safeImage(i.currentSrc || i.src)).filter((s): s is string => !!s).slice(0, 4);
  const coverBox = article.querySelector('[data-testid="article-cover-image"]');
  const cover = coverBox?.querySelector<HTMLImageElement>('img[alt*="文章封面"], img') ?? null;
  const coverUrl = cover ? safeImage(cover.currentSrc || cover.src) : null;
  const articleText = coverBox?.parentElement ? [...coverBox.parentElement.querySelectorAll<HTMLElement>(':scope > div:last-child [dir="auto"]')].map(textOf).filter(Boolean) : [];
  const articleCard = coverUrl && articleText[0] ? { cover: coverUrl, title: articleText[0].slice(0, 300), description: (articleText[1] ?? '').slice(0, 2000) } : undefined;
  const isVideo = !!article.querySelector('video, [data-testid="videoPlayer"], [data-testid="videoComponent"]');
  const timestamp = link.querySelector('time')?.getAttribute('datetime');
  return {
    id: match[2], url: `https://x.com/${authorHandle}/status/${match[2]}`, authorHandle,
    authorName, text: mainText ? textOf(mainText).slice(0, 30000) : '',
    quotedText: texts.filter(t => t !== mainText).map(textOf).join('\n').slice(0, 10000),
    images, media: isVideo ? 'video' : images.length || articleCard ? 'image' : 'text', article: articleCard,
    postedAt: timestamp && Number.isFinite(Date.parse(timestamp)) ? Date.parse(timestamp) : null
  };
}

export function isAllowedPage(pathname: string): boolean {
  return !/^\/(?:messages|i\/(?:chat|messages|grok)|settings|login|logout|signup|account)(?:\/|$)/i.test(pathname);
}

export function enoughVisible(rect: Pick<DOMRect, 'width' | 'height'>, intersection: Pick<DOMRect, 'width' | 'height'>, viewportWidth: number, viewportHeight: number): boolean {
  if (rect.height <= 0 || rect.width <= 0) return false;
  // Long posts should still qualify when they fill the screen.
  return intersection.height >= Math.min(rect.height, viewportHeight) * 0.5 && intersection.width >= Math.min(rect.width, viewportWidth) * 0.5;
}
