import { getRedis, redisEnabled } from "./limiter.js";

// Persistent record of every rendered comic, keyed by comic id. Two features depend on it:
//   1. Per-page revision — needs the finished page image URLs + storyboard to rebuild one page.
//   2. Public gallery — lists comics whose creator opted in (public:true), newest first.
// Best-effort throughout: a Redis outage means a comic just isn't recorded (no revision/gallery for
// it), never a failed render. All keys are namespaced `lifecomic:` so a shared Redis is safe.
const KEY = (id) => `lifecomic:comic:${id}`;
const GALLERY_KEY = "lifecomic:gallery"; // sorted set: member = comic id, score = createdAt (ms)
const RECORD_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days
const GALLERY_MAX = 500; // cap the public index so it can't grow unbounded

function ready(redis) {
  return Boolean(redis) && redis.status === "ready";
}

/**
 * Records a finished comic. `comic` is runComic's return object (id, title, files, etc.). `public`
 * (opt-in, default false) controls whether it's added to the public gallery index — comics are often
 * personal stories, so nothing is listed publicly unless the caller explicitly asked. Returns nothing;
 * best-effort.
 */
export async function recordComic(comic, { isPublic = false } = {}) {
  if (!redisEnabled()) return;
  const redis = getRedis();
  if (!ready(redis)) return;
  const record = {
    id: comic.id,
    title: comic.title,
    cover: comic.files?.pages?.[0] ?? null,
    pdf: comic.files?.pdf ?? null,
    cbz: comic.files?.cbz ?? null,
    pages: comic.files?.pages ?? [],
    storyboardUrl: comic.files?.storyboard ?? null,
    seriesId: comic.seriesId ?? null,
    style: comic.style ?? null,
    public: Boolean(isPublic),
    createdAt: Date.now(),
  };
  try {
    await redis.set(KEY(comic.id), JSON.stringify(record), "EX", RECORD_TTL_SECONDS);
    if (isPublic) {
      await redis.zadd(GALLERY_KEY, record.createdAt, comic.id);
      // Trim the index to the newest GALLERY_MAX ids so it stays bounded.
      const size = await redis.zcard(GALLERY_KEY);
      if (size > GALLERY_MAX) await redis.zremrangebyrank(GALLERY_KEY, 0, size - GALLERY_MAX - 1);
    }
  } catch {
    // best-effort — the comic already rendered successfully
  }
}

/** Loads one comic record, or null if unknown/expired/Redis unavailable. */
export async function getComic(id) {
  if (!id || !redisEnabled()) return null;
  const redis = getRedis();
  if (!ready(redis)) return null;
  try {
    const raw = await redis.get(KEY(id));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Lists the most recent public comics (newest first) as compact gallery entries. Skips records that
 * expired out from under the index. `limit` is clamped to [1, 100].
 */
export async function listPublicComics({ limit = 30 } = {}) {
  if (!redisEnabled()) return [];
  const redis = getRedis();
  if (!ready(redis)) return [];
  const n = Math.max(1, Math.min(100, Math.floor(Number(limit) || 30)));
  try {
    const ids = await redis.zrevrange(GALLERY_KEY, 0, n - 1);
    if (!ids.length) return [];
    const raws = await redis.mget(ids.map(KEY));
    return raws
      .filter(Boolean)
      .map((r) => JSON.parse(r))
      .map((c) => ({ id: c.id, title: c.title, cover: c.cover, pdf: c.pdf, seriesId: c.seriesId, style: c.style, createdAt: c.createdAt }));
  } catch {
    return [];
  }
}
