export type MediaKind = 'text' | 'image' | 'video';
export interface ArticleCard { cover: string; title: string; description: string }
export interface CapturedPost {
  id: string; url: string; authorName: string; authorHandle: string; text: string;
  postedAt: number | null; images: string[]; media: MediaKind; quotedText: string; article?: ArticleCard;
}
export interface Post extends CapturedPost {
  firstViewedAt: number; lastViewedAt: number; viewCount: number; dwellMs: number;
  lastEventId: string; lastEventDwell: number; searchText: string; grams: string[];
}
export interface Capture { post: CapturedPost; viewedAt: number; dwellMs: number; eventId: string }
export interface Settings {
  paused: boolean; dwellMs: number; retentionDays: number; maxRecords: number;
  showImages: boolean; excludePromoted: boolean; theme: 'system' | 'light' | 'dark';
}
export const DEFAULT_SETTINGS: Settings = {
  paused: false, dwellMs: 1000, retentionDays: 0, maxRecords: 20000,
  showImages: false, excludePromoted: true, theme: 'system'
};
export interface SearchQuery {
  text: string; author: string; from: number | null; to: number | null;
  media: '' | MediaKind | 'article'; sort: 'newest' | 'oldest'; cursor?: { time: number; id: string };
}
export const EMPTY_QUERY: SearchQuery = { text: '', author: '', from: null, to: null, media: '', sort: 'newest' };
export type PostSummary = Omit<Post, 'grams' | 'searchText' | 'lastEventId' | 'lastEventDwell'>;
export interface SearchResult { posts: PostSummary[]; next: SearchQuery['cursor']; matched: number; scanned: number; elapsedMs: number }
export const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
export function makeGrams(text: string): string[] {
  const chars = Array.from(text); const grams = new Set<string>();
  for (let i = 0; i < chars.length - 1; i++) if (chars[i] !== ' ' && chars[i + 1] !== ' ') grams.add(chars[i] + chars[i + 1]);
  return [...grams];
}
export function searchData(post: CapturedPost) {
  const searchText = normalize(`${post.text} ${post.authorName} ${post.authorHandle} ${post.quotedText} ${post.article?.title ?? ''} ${post.article?.description ?? ''}`);
  return { searchText, grams: makeGrams(searchText) };
}
export function cleanSettings(value: Partial<Settings>): Settings {
  return {
    paused: value.paused === true,
    dwellMs: [800, 1000, 1500, 2000].includes(value.dwellMs!) ? value.dwellMs! : 1000,
    retentionDays: [0, 30, 90, 180, 365].includes(value.retentionDays!) ? value.retentionDays! : 0,
    maxRecords: [5000, 20000, 50000].includes(value.maxRecords!) ? value.maxRecords! : 20000,
    showImages: value.showImages === true, excludePromoted: value.excludePromoted !== false,
    theme: ['system', 'light', 'dark'].includes(value.theme!) ? value.theme! : 'system'
  };
}
export function safeImage(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 2048) return null;
  try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'pbs.twimg.com' && /^\/(media|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//.test(u.pathname) ? u.href : null; } catch { return null; }
}
export function cleanPost(value: unknown): CapturedPost | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  if (typeof p.id !== 'string' || !/^\d{5,25}$/.test(p.id) || typeof p.authorHandle !== 'string' || !/^[a-zA-Z0-9_]{1,15}$/.test(p.authorHandle)) return null;
  if (typeof p.text !== 'string' || typeof p.authorName !== 'string') return null;
  const rawArticle = p.article;
  const article = rawArticle && typeof rawArticle === 'object' ? rawArticle as Record<string, unknown> : null;
  const cover = article ? safeImage(article.cover) : null;
  const title = article && typeof article.title === 'string' ? article.title.trim().slice(0, 300) : '';
  const description = article && typeof article.description === 'string' ? article.description.trim().slice(0, 2000) : '';
  return {
    id: p.id, url: `https://x.com/${p.authorHandle}/status/${p.id}`, authorHandle: p.authorHandle.toLowerCase(),
    authorName: p.authorName.slice(0, 200), text: p.text.slice(0, 30000),
    quotedText: typeof p.quotedText === 'string' ? p.quotedText.slice(0, 10000) : '',
    postedAt: typeof p.postedAt === 'number' && Number.isFinite(p.postedAt) && p.postedAt > 0 && p.postedAt <= Date.now() + 86400000 ? p.postedAt : null,
    media: p.media === 'video' || p.media === 'image' ? p.media : 'text',
    images: Array.isArray(p.images) ? p.images.slice(0, 4).map(safeImage).filter((x): x is string => !!x) : [],
    ...(cover && title ? { article: { cover, title, description } } : {})
  };
}
export const summarize = ({ grams, searchText, lastEventId, lastEventDwell, ...post }: Post): PostSummary => post;
export function validTime(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= Date.now() + 60000; }
