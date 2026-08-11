/**
 * Voice Vibes — Cloudflare Worker
 *
 * Serves the whole game: static assets, Discord OAuth exchange,
 * global game state machine (server-authoritative scoring), Firebase proxy.
 *
 * BOT-DRAWS MODEL:
 *  - vibes/global/game      = { anchor, turnDuration, intermission, onlineWindow }
 *  - vibes/global/words/<n> = word for turn n — picked by the WORKER (the bot)
 *  - vibes/global/turns/<n> = { allGuessedAt?, guessed: {<uid>: true} }
 *  - vibes/global/guesses/<n>/<uid> = { uid, text, at, correct, points? }
 *  - vibes/global/players/<uid> = { id, username, avatarUrl, score, lastSeen, joinedAt }  (persistent)
 *
 * Turns are deterministic: turn n starts at anchor + n*turnDuration. The bot
 * (worker) lazily picks the word on the first API call of each turn, then
 * every client animates the drawing from the shared vector library. Scoring
 * is 100% server-side → no cheating, persistent leaderboard.
 */

const FB_DEFAULT_HOST = "bible-game-21-default-rtdb.firebaseio.com";
const P = "vibes/global";

const TURN_DURATION = 70; // seconds per turn
const INTERMISSION = 8; // seconds between turns (after early end)
const ONLINE_WINDOW = 120; // seconds without heartbeat → offline
const IDLE_RESET_MS = 60 * 60 * 1000; // reset anchor if arena empty for 1h
const PRUNE_BEHIND = 30; // turns of history to keep

// Bot's vocabulary — injected at build time from src/drawings.js keys.
const WORDS = __DRAWING_WORDS__;

function norm(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

// ── Firebase helpers ────────────────────────────────────────────────────────
function fbUrl(env, path) {
  const host = (env.FB_HOST || FB_DEFAULT_HOST).replace(/^https?:\/\//, "");
  return `https://${host}/${path}.json`;
}

async function fbGet(env, path) {
  const res = await fetch(fbUrl(env, path));
  if (!res.ok) throw new Error(`fbGet ${path} → ${res.status}`);
  return res.json();
}

async function fbPut(env, path, data) {
  const res = await fetch(fbUrl(env, path), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`fbPut ${path} → ${res.status}`);
  return res.json();
}

async function fbPatch(env, path, data) {
  const res = await fetch(fbUrl(env, path), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`fbPatch ${path} → ${res.status}`);
  return res.json();
}

async function fbDelete(env, path) {
  const res = await fetch(fbUrl(env, path), { method: "DELETE" });
  if (!res.ok) throw new Error(`fbDelete ${path} → ${res.status}`);
  return res.json();
}

// ── game state ──────────────────────────────────────────────────────────────
async function ensureGame(env) {
  let game = await fbGet(env, `${P}/game`).catch(() => null);
  if (!game || !game.anchor) {
    game = {
      anchor: Date.now(),
      turnDuration: TURN_DURATION,
      intermission: INTERMISSION,
      onlineWindow: ONLINE_WINDOW,
      startedAt: Date.now(),
    };
    await fbPut(env, `${P}/game`, game);
  }
  return game;
}

function currentTurn(game, nowMs) {
  return Math.floor((nowMs - game.anchor) / (game.turnDuration * 1000));
}

function turnStart(game, n, nowMs) {
  return game.anchor + n * game.turnDuration * 1000;
}

function onlinePlayers(players, nowMs, windowMs) {
  const cutoff = nowMs - windowMs;
  return Object.values(players || {})
    .filter((p) => p && p.id && (p.lastSeen || 0) > cutoff)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// The bot picks the word for turn n. Idempotent — first caller wins.
async function ensureWord(env, n) {
  const existing = await fbGet(env, `${P}/words/${n}`).catch(() => null);
  if (existing) return existing;
  const word = WORDS[Math.floor(Math.random() * WORDS.length)];
  await fbPut(env, `${P}/words/${n}`, word);
  return word;
}

// ── /api/join — register player, maybe restart an idle arena ────────────────
async function handleJoin(request, env, ctx) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = await request.json().catch(() => ({}));
  const { id, username, avatarUrl } = body;
  if (!id || typeof id !== "string") return json({ error: "id required" }, 400);

  const nowMs = Date.now();
  let game = await ensureGame(env);
  const players = (await fbGet(env, `${P}/players`).catch(() => ({}))) || {};

  // Arena idle (nobody online for a long time) → restart the clock so the
  // first joiner gets a fresh turn immediately.
  const online = onlinePlayers(players, nowMs, game.onlineWindow * 1000).filter((p) => p.id !== id);
  if (online.length === 0 && nowMs - game.anchor > IDLE_RESET_MS) {
    game = { ...game, anchor: nowMs };
    await fbPut(env, `${P}/game`, game);
  }

  const existing = players[id] || {};
  const player = {
    id,
    username: String(username || existing.username || "Player").slice(0, 24),
    avatarUrl: typeof avatarUrl === "string" ? avatarUrl.slice(0, 300) : existing.avatarUrl || "",
    score: existing.score || 0,
    lastSeen: nowMs,
    joinedAt: existing.joinedAt || nowMs,
  };
  players[id] = player;
  await fbPut(env, `${P}/players/${id}`, player);

  // Make sure the current turn has a word (bot picks fast on join).
  const n = currentTurn(game, nowMs);
  ctx.waitUntil(ensureWord(env, n).catch(() => {}));
  ctx.waitUntil(pruneTurns(env, n));

  return json({ game, players, now: nowMs });
}

async function pruneTurns(env, currentN) {
  const keepFrom = currentN - PRUNE_BEHIND;
  if (keepFrom <= 0) return;
  for (let k = 0; k < keepFrom; k += 10) {
    const batch = [];
    for (let i = k; i < Math.min(k + 10, keepFrom); i++) batch.push(i);
    await Promise.all(
      batch.map(async (i) => {
        try {
          await Promise.all([
            fbDelete(env, `${P}/words/${i}`),
            fbDelete(env, `${P}/turns/${i}`),
            fbDelete(env, `${P}/guesses/${i}`),
          ]);
        } catch (e) {
          /* best effort */
        }
      }),
    );
  }
}

// ── /api/ensure-word — any client may trigger the bot's pick ────────────────
async function handleEnsureWord(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = await request.json().catch(() => ({}));
  const nowMs = Date.now();
  const game = await ensureGame(env);
  const n = currentTurn(game, nowMs);
  if (typeof body.turn === "number" && body.turn !== n) {
    return json({ error: "Stale turn." }, 409);
  }
  const word = await ensureWord(env, n);
  return json({ ok: true, word });
}

// ── /api/guess — server-authoritative scoring ───────────────────────────────
async function handleGuess(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = await request.json().catch(() => ({}));
  const { uid, turn, text } = body;
  if (!uid || !text || typeof text !== "string") return json({ error: "uid and text required" }, 400);

  const nowMs = Date.now();
  const game = await ensureGame(env);
  const n = currentTurn(game, nowMs);
  if (turn !== n) return json({ error: "That turn is over — you're in the next one!" }, 409);

  const word = await ensureWord(env, n);
  if (!word) return json({ error: "The bot hasn't picked a word yet." }, 409);

  const players = (await fbGet(env, `${P}/players`).catch(() => ({}))) || {};

  const turns = (await fbGet(env, `${P}/turns/${n}`).catch(() => ({}))) || {};
  const guessed = turns.guessed || {};
  if (guessed[uid]) return json({ error: "You already got it! ⭐" }, 409);

  const s = turnStart(game, n, nowMs);
  const T = game.turnDuration * 1000;
  const drawingEnd = turns.allGuessedAt || s + T;
  if (nowMs > drawingEnd) return json({ error: "Turn's over!" }, 409);

  const correct = norm(text) === norm(word);
  const guess = { uid, text: text.slice(0, 60), at: nowMs, correct };

  if (!correct) {
    await fbPut(env, `${P}/guesses/${n}/${uid}`, guess);
    return json({ correct: false });
  }

  // Correct! Speed bonus: 50–200 pts.
  const timeLeft = Math.max(0, drawingEnd - nowMs);
  const points = Math.round(50 + (timeLeft / T) * 150);

  const me = players[uid] || {};
  const newScore = (me.score || 0) + points;
  guess.points = points;
  await fbPut(env, `${P}/guesses/${n}/${uid}`, guess);
  await fbPut(env, `${P}/players/${uid}`, {
    id: uid,
    username: me.username || "Player",
    avatarUrl: me.avatarUrl || "",
    score: newScore,
    lastSeen: nowMs,
    joinedAt: me.joinedAt || nowMs,
  });

  await fbPatch(env, `${P}/turns/${n}`, { guessed: { [uid]: true } });

  // All online players guessed → end the turn early, re-anchor the clock.
  const onlineAll = onlinePlayers(players, nowMs, game.onlineWindow * 1000);
  const allGot = onlineAll.length > 0 && onlineAll.every((p) => guessed[p.id] || p.id === uid);
  if (allGot) {
    const E = nowMs;
    await fbPatch(env, `${P}/turns/${n}`, { allGuessedAt: E });
    const newAnchor = E + game.intermission * 1000 - (n + 1) * T;
    await fbPut(env, `${P}/game`, { ...game, anchor: newAnchor });
  }

  return json({ correct: true, points, score: newScore });
}

// ── /api/time — clock sync ──────────────────────────────────────────────────
async function handleTime(request, env, ctx) {
  const game = await fbGet(env, `${P}/game`).catch(() => null);
  if (game?.anchor) {
    const n = currentTurn(game, Date.now());
    ctx.waitUntil(ensureWord(env, n).catch(() => {}));
  }
  return json({ now: Date.now(), game: game || null });
}

// ── Discord OAuth exchange (Bible Trivia / Arrow Blast pattern) ─────────────
async function handleExchange(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let code;
  try {
    const body = await request.json();
    code = body && body.code;
  } catch {
    return json({ error: "Bad request — code required" }, 400);
  }
  if (!code || typeof code !== "string") return json({ error: "Bad request — code required" }, 400);

  const clientId = env.DISCORD_CLIENT_ID;
  const clientSecret = env.DISCORD_CLIENT_SECRET;
  const redirectUri = env.REDIRECT_URI;

  if (!clientId || !clientSecret) {
    return json({ error: "Server configuration error — DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET not set" }, 500);
  }

  try {
    const resp = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      return json({ error: data.error, description: data.error_description }, resp.status);
    }
    return json({ access_token: data.access_token });
  } catch (err) {
    console.error("[Exchange] Internal error:", err.message);
    return json({ error: "Internal server error" }, 500);
  }
}

// ── Firebase proxies (Bible Trivia pattern) ─────────────────────────────────
function upstreamUrl(env, pathAfter, search) {
  const host = (env.FB_HOST || FB_DEFAULT_HOST).replace(/^https?:\/\//, "");
  const u = new URL(`https://${host}${pathAfter}`);
  u.search = search;
  return u;
}

async function restProxy(request, env, url) {
  const pathAfter = url.pathname.replace(/^\/firebase/, "");
  const target = upstreamUrl(env, pathAfter, url.search);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("cf-connecting-ip");
  headers.set("origin", url.origin);
  const method = headers.get("x-fb-method") || request.method;
  headers.delete("x-fb-method");
  const init = { method, headers, redirect: "follow" };
  if (method !== "GET" && method !== "HEAD") {
    init.body = request.body;
  }
  const res = await fetch(target, init);
  const outHeaders = new Headers(res.headers);
  outHeaders.set("Cache-Control", "no-store");
  outHeaders.set("Access-Control-Allow-Origin", url.origin);
  return new Response(res.body, { status: res.status, headers: outHeaders });
}

async function sseProxy(request, env, url) {
  const pathAfter = url.pathname.replace(/^\/firebase\/stream/, "");
  const target = upstreamUrl(env, pathAfter, url.search);
  const upstream = await fetch(target, { headers: { Accept: "text/event-stream" } });
  if (!upstream.ok || !upstream.body) {
    return json({ error: `upstream ${upstream.status}` }, upstream.status);
  }
  const headers = new Headers();
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("X-Accel-Buffering", "no");
  headers.set("Access-Control-Allow-Origin", url.origin);
  return new Response(upstream.body, { status: 200, headers });
}

// ── Support page (redirects to the real support site) ──────────────────────
const SUPPORT_URL = "https://walusimbi-leon1.github.io/voice-support/";
function handleSupport() {
  return Response.redirect(SUPPORT_URL, 302);
}

function notFound() {
  return new Response("Not found", { status: 404 });
}

// ── Static assets (inlined at build time by build.js) ───────────────────────
// NOTE: do not wrap these in backticks — the files contain backticks of
// their own (template literals), which would break the outer literal.
const STATIC = {
  "index.html": __INDEX_HTML__,
  "style.css": __STYLE_CSS__,
  "app.js": __APP_JS__,
  "canvas.js": __CANVAS_JS__,
  "discord.js": __DISCORD_JS__,
  "drawings.js": __DRAWINGS_JS__,
  "firebase.js": __FIREBASE_JS__,
  "support.js": __SUPPORT_JS__,
  "vendor/discord-sdk.mjs": __VENDOR_DISCORD_SDK_MJS__,
  "privacy.html": __PRIVACY_HTML__,
  "terms.html": __TERMS_HTML__,
};

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path.startsWith("/firebase/stream/")) return await sseProxy(request, env, url);
      if (path.startsWith("/firebase/")) return await restProxy(request, env, url);
      if (path === "/api/exchange" && request.method === "POST") return await handleExchange(request, env);
      if (path === "/api/join" && request.method === "POST") return await handleJoin(request, env, ctx);
      if (path === "/api/guess" && request.method === "POST") return await handleGuess(request, env);
      if (path === "/api/ensure-word" && request.method === "POST") return await handleEnsureWord(request, env);
      if (path === "/api/time") return await handleTime(request, env, ctx);
      if (path === "/privacy") return html(STATIC["privacy.html"]);
      if (path === "/terms") return html(STATIC["terms.html"]);
      if (path === "/support") return await handleSupport();
      if (path === "/" || path === "") {
        return html(STATIC["index.html"]);
      }
      const assetPath = path.slice(1);
      const content = STATIC[assetPath];
      if (content !== undefined) {
        const ext = "." + (assetPath.split(".").pop() || "");
        return new Response(content, {
          headers: { "Content-Type": CONTENT_TYPES[ext] || "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
        });
      }
      return notFound();
    } catch (err) {
      console.error("[VoiceVibes] error:", err.message);
      return json({ error: "Internal error" }, 500);
    }
  },
};
