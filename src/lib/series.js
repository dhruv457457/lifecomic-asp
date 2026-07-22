import { getRedis, redisEnabled } from "./limiter.js";

// Multi-chapter continuity: a caller passes the same `seriesId` on later calls to keep the same
// cast, style/tone, and (when storage is configured) the SAME generated reference art across
// chapters — not just the same text description. Best-effort throughout: any Redis failure just
// means a chapter renders standalone instead of continuing the series, never a hard failure.
const NS = "lifecomic:series:";
const TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days — long enough for a slow-drip serialized story

function ready(redis) {
  return Boolean(redis) && redis.status === "ready";
}

/** Loads a series' continuity record, or null if unknown/expired/Redis unavailable. */
export async function loadSeries(seriesId) {
  if (!seriesId || !redisEnabled()) return null;
  const redis = getRedis();
  if (!ready(redis)) return null;
  try {
    const raw = await redis.get(`${NS}${seriesId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Saves continuity after a successful render and returns the new chapter number (1 for a brand-new
 * series). `storyboard` is the rendered result's storyboard — its cast, style/tone, and art_direction
 * (including any reference_url panels.js uploaded for this series) become next chapter's defaults.
 */
export async function saveSeries(seriesId, storyboard) {
  if (!seriesId || !redisEnabled()) return null;
  const redis = getRedis();
  if (!ready(redis)) return null;
  const prior = await loadSeries(seriesId);
  const chapterNumber = (prior?.chapterNumber || 0) + 1;
  const referenceImages = storyboard.character_bible?.reference_url
    ? [storyboard.character_bible.reference_url]
    : prior?.artDirection?.referenceImages;
  const artDirection = storyboard.art_direction || prior?.artDirection
    ? { ...prior?.artDirection, ...storyboard.art_direction, ...(referenceImages?.length ? { referenceImages } : {}) }
    : undefined;
  const data = {
    chapterNumber,
    characters: storyboard.character_bible?.characters || prior?.characters,
    style: storyboard.style,
    tone: storyboard.tone,
    artDirection,
    updatedAt: new Date().toISOString(),
  };
  try {
    await redis.set(`${NS}${seriesId}`, JSON.stringify(data), "EX", TTL_SECONDS);
  } catch {
    // best-effort — the chapter already rendered successfully either way
  }
  return chapterNumber;
}

/**
 * Fills in a request's characters/style/tone/artDirection from prior chapters when the caller didn't
 * explicitly supply them — so chapter 2+ of a series only needs the NEW beat, not the whole cast
 * re-typed. Anything the caller DID supply always wins (never silently overridden).
 */
export function applySeriesDefaults(request, series) {
  if (!series) return request;
  const next = { ...request };
  if (!next.characters && Array.isArray(series.characters)) {
    next.characters = series.characters.map((c) => ({ name: c.name, description: c.visual_description, continuity_notes: c.continuity_notes }));
  }
  if (!next.style && series.style) next.style = series.style;
  if (!next.tone && series.tone) next.tone = series.tone;
  if (!next.artDirection && series.artDirection) next.artDirection = series.artDirection;
  return next;
}
