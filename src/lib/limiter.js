import Redis from "ioredis";

// Rate limiting + free-spend budget, backed by Redis when REDIS_URL is set (so the limits survive
// restarts and are shared across instances) and falling back to in-memory otherwise. All Redis keys
// are namespaced `lifecomic:` so this can safely reuse a Redis instance shared with other apps.
// Every Redis call falls back to the in-memory path on error, so a Redis outage never opens the gate.

const NS = "lifecomic:";
let redisClient;
let redisTried = false;

export function getRedis() {
  if (redisTried) return redisClient;
  redisTried = true;
  const url = process.env.REDIS_URL;
  if (!url) {
    redisClient = null;
    return null;
  }
  redisClient = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false, enableOfflineQueue: false });
  redisClient.on("error", (e) => console.warn("[redis] error:", e instanceof Error ? e.message : e));
  return redisClient;
}

export function redisEnabled() {
  return Boolean(process.env.REDIS_URL);
}

/**
 * Express middleware limiting each client IP to `max` requests per `windowMs`. Uses an atomic Redis
 * INCR+PEXPIRE when available; otherwise an in-memory sliding window. `prefix` separates buckets
 * (e.g. global vs. preview).
 */
export function createRateLimiter({ windowMs = 60_000, max = 60, prefix = "global" } = {}) {
  const memory = new Map();

  function memoryHit(key) {
    const now = Date.now();
    const entry = memory.get(key) ?? { count: 0, resetAt: now + windowMs };
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + windowMs;
    }
    entry.count += 1;
    memory.set(key, entry);
    return { count: entry.count, resetMs: entry.resetAt - now };
  }

  return async (req, res, next) => {
    const ip = req.ip ?? "unknown";
    const redis = getRedis();
    let count;
    let resetMs = windowMs;
    if (redis && redis.status === "ready") {
      try {
        const key = `${NS}rl:${prefix}:${ip}`;
        count = await redis.incr(key);
        if (count === 1) await redis.pexpire(key, windowMs);
      } catch {
        ({ count, resetMs } = memoryHit(ip)); // Redis hiccup -> in-memory still enforces the limit
      }
    } else {
      ({ count, resetMs } = memoryHit(ip));
    }
    if (count > max) {
      res.status(429).json({ error: "rate limit exceeded", retryAfterMs: resetMs });
      return;
    }
    next();
  };
}

/**
 * Per-day free-spend budget (USD). Backed by Redis INCRBYFLOAT when available so the ceiling holds
 * across restarts/instances; in-memory otherwise. Returns { remaining(), record(usd) }.
 */
export function createSpendBudget(dailyUsd) {
  let mem = { day: "", usd: 0 };
  const today = () => new Date().toISOString().slice(0, 10);

  async function spentToday() {
    const day = today();
    const redis = getRedis();
    if (redis && redis.status === "ready") {
      try {
        return Number(await redis.get(`${NS}budget:${day}`)) || 0;
      } catch {
        /* fall through to memory */
      }
    }
    if (mem.day !== day) mem = { day, usd: 0 };
    return mem.usd;
  }

  return {
    async remaining() {
      return dailyUsd - (await spentToday());
    },
    async record(usd) {
      const amount = Number(usd) || 0;
      const day = today();
      const redis = getRedis();
      if (redis && redis.status === "ready") {
        try {
          const key = `${NS}budget:${day}`;
          await redis.incrbyfloat(key, amount);
          await redis.expire(key, 60 * 60 * 48); // auto-clean after 2 days
          return;
        } catch {
          /* fall through to memory */
        }
      }
      if (mem.day !== day) mem = { day, usd: 0 };
      mem.usd += amount;
    },
  };
}
