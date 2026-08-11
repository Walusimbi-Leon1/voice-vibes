/**
 * Voice Vibes — global "bot draws, you guess" game engine.
 *
 * GLOBAL ROOM MODEL (Bible Trivia pattern):
 *  - ONE room for everyone. No room codes, no host, no start button.
 *  - Turns are deterministic and time-sliced:
 *      turn N starts at  anchor + N * turnDuration
 *    Every client computes the same turn from shared state.
 *  - A BOT draws every picture. The worker picks the word at turn start
 *    (lazily, on the first API call) and reveals it by drawing the vector
 *    strokes progressively on every player's canvas.
 *  - Scoring is server-authoritative via /api/guess: speed bonus up to
 *    200 pts. Persistent leaderboard in Firebase RTDB.
 *
 * Data (RTDB via same-origin /firebase proxy):
 *  vibes/global/game              = { anchor, turnDuration, intermission, onlineWindow }
 *  vibes/global/words/<turn>      = word (the bot's pick — hidden in the UI)
 *  vibes/global/turns/<turn>      = { allGuessedAt?, guessed: {<uid>: true} }
 *  vibes/global/guesses/<turn>/<uid> = { text, at, correct, points? }
 *  vibes/global/players/<uid>     = { id, username, avatarUrl, score, lastSeen, online, joinedAt }
 */

import { initDiscord } from "./discord.js";
import { dbRead, dbUpdate, dbWatch } from "./firebase.js";
import { DRAWINGS } from "./drawings.js";
import { createBotCanvas } from "./canvas.js";

const P = "vibes/global";

const GAME_DEFAULTS = {
  anchor: null,
  turnDuration: 70,
  intermission: 8,
  onlineWindow: 120,
};

const DRAW_START = 1.5; // seconds into the turn before the bot starts drawing
const DRAW_END = 56; // drawing finishes (full picture + 14s to admire/guess)
const HINT_1_AT = 35; // seconds: first-letter hint
const HINT_2_AT = 50; // seconds: second-letter hint

const $ = (sel) => document.querySelector(sel);

// ── identity ────────────────────────────────────────────────────────────────
let me = { id: null, username: "Guest", avatarUrl: "", score: 0 };

function getGuestId() {
  let id = localStorage.getItem("vv_player_id");
  if (!id) {
    id = "g" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    localStorage.setItem("vv_player_id", id);
  }
  return id;
}

function guestNameFromId(id) {
  const n = parseInt(id.slice(1, 3), 16) || 7;
  const names = ["Scribble", "Doodle", "Pixel", "Brush", "Ink", "Sketch", "Splash", "Quill", "Canvas", "Marble"];
  return names[n % names.length] + (n % 10);
}

async function resolveIdentity() {
  const d = await initDiscord();
  if (d && d.user) {
    return {
      id: "u" + d.user.id,
      username: d.user.global_name || d.user.username || "Player",
      avatarUrl: `https://cdn.discordapp.com/avatars/${d.user.id}/${d.user.avatar || "0"}.png`,
    };
  }
  const gid = getGuestId();
  const saved = localStorage.getItem("vv_player_name");
  return { id: gid, username: saved || guestNameFromId(gid), avatarUrl: "" };
}

// ── game state ──────────────────────────────────────────────────────────────
let game = { ...GAME_DEFAULTS };
let players = {};
let turnData = { N: -1, word: null, allGuessedAt: null, guessed: {}, guesses: {} };
let words = {};
let offset = 0;
let canvas = null;
let channels = [];
let turnChannels = [];
let phase = "loading";
let chatLog = [];
let iGuessedTurn = -1;
let ensurePosted = false;
let lastDomUpdate = 0;

function now() {
  return Date.now() + offset;
}

function currentTurn() {
  if (!game.anchor) return -1;
  return Math.floor((now() - game.anchor) / (game.turnDuration * 1000));
}

function turnStart(N) {
  return game.anchor + N * game.turnDuration * 1000;
}

// ── phase derivation (deterministic, all clients) ───────────────────────────
function computePhase() {
  const N = currentTurn();
  if (N < 0) return { N, phase: "idle", timeLeft: 0 };
  const word = words[N] || null;
  const t = now() - turnStart(N);
  const T = game.turnDuration * 1000;
  const allGuessedAt = turnData.N === N ? turnData.allGuessedAt : null;

  let phase;
  if (!word && t < 4000) phase = "picking"; // bot "choosing" briefly
  else if (!word) phase = "picking-timeout";
  else if (allGuessedAt) phase = "intermission";
  else if (t < T) phase = "drawing";
  else phase = "intermission";

  let timeLeft = 0;
  if (phase === "drawing") {
    const end = allGuessedAt || turnStart(N) + T;
    timeLeft = Math.max(0, (end - now()) / 1000);
  } else if (phase === "intermission") {
    const end = turnStart(N + 1);
    timeLeft = Math.max(0, (end - now()) / 1000);
  } else if (phase === "picking") {
    timeLeft = Math.max(0, (4000 - t) / 1000);
  }
  return { N, phase, timeLeft, word, t, T };
}

// ── UI ──────────────────────────────────────────────────────────────────────
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function setScreen(name) {
  ["loading", "error", "game"].forEach((s) => {
    const scr = $("#screen-" + s);
    if (scr) scr.classList.toggle("hidden", s !== name);
  });
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function initials(name) {
  return (name || "?").trim().slice(0, 1).toUpperCase();
}

function hashColor(id) {
  const palette = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16"];
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

function avatarHtml(p, size) {
  const s = size || 30;
  if (p.avatarUrl) {
    return `<img class="avatar" style="width:${s}px;height:${s}px" src="${escapeHtml(p.avatarUrl)}" alt="">`;
  }
  return `<div class="avatar avatar-fallback" style="width:${s}px;height:${s}px;background:${hashColor(p.id)}">${escapeHtml(initials(p.username))}</div>`;
}

function renderMe() {
  const meEl = $("#header-me");
  meEl.innerHTML =
    avatarHtml(me, 28) +
    `<span class="me-name">${escapeHtml(me.username)}</span>` +
    `<span class="me-score">⭐ ${me.score}</span>`;
}

function renderLeaderboard() {
  const cutoff = now() - (game.onlineWindow || 120) * 1000;
  const all = Object.values(players)
    .filter((p) => p && p.id)
    .sort((a, b) => (b.score || 0) - (a.score || 0) || (a.joinedAt || 0) - (b.joinedAt || 0));
  const list = $("#lb-list");
  list.innerHTML = "";
  if (!all.length) {
    list.appendChild(el("p", "muted small", "No players yet — be the first!"));
  } else {
    all.slice(0, 10).forEach((p, i) => {
      const mine = p.id === me.id;
      const online = (p.lastSeen || 0) > cutoff;
      const row = el("div", "lb-row" + (mine ? " mine" : ""));
      row.innerHTML =
        `<span class="lb-rank">${i + 1}</span>` +
        avatarHtml(p, 26) +
        `<span class="lb-name">${escapeHtml(p.username)}${mine ? '<span class="you-tag">you</span>' : ""}</span>` +
        `<span class="lb-online ${online ? "" : "off"}">●</span>` +
        `<span class="lb-score">⭐ ${p.score || 0}</span>`;
      list.appendChild(row);
    });
  }
  const myRank = all.findIndex((p) => p.id === me.id);
  $("#my-rank").textContent =
    myRank >= 0
      ? `Your rank: #${myRank + 1} of ${all.length} · ⭐ ${me.score} pts`
      : "Join the arena to rank up!";
}

function hintFor(word, t) {
  if (!word) return null;
  if (t >= HINT_2_AT && word.length > 1) {
    return `💡 Hint: starts with "${word[0].toUpperCase()}", letter 2 is "${word[1].toUpperCase()}"`;
  }
  if (t >= HINT_1_AT) {
    return `💡 Hint: starts with "${word[0].toUpperCase()}"`;
  }
  return null;
}

function renderStatus(ph) {
  const box = $("#status-box");
  box.innerHTML = "";

  if (ph.phase === "idle") {
    box.appendChild(el("div", "status-title", "🌍 Global Arena"));
    box.appendChild(el("div", "muted", "The bot draws, you guess. Waiting for the first player…"));
    return;
  }

  box.appendChild(el("div", "status-round", `Turn ${ph.N + 1}`));

  if (ph.phase === "picking" || ph.phase === "picking-timeout") {
    box.appendChild(el("div", "status-title", "🤖 The bot is choosing a word…"));
  } else if (ph.phase === "drawing") {
    const t = ph.t / 1000;
    box.appendChild(el("div", "status-title", "🤖 The bot is drawing…"));
    const hint = hintFor(ph.word, t);
    if (hint) box.appendChild(el("div", "hint-line", hint));
    if (iGuessedTurn === ph.N) {
      box.appendChild(el("div", "got-it", "✅ You got it! Watch the drawing finish…"));
    }
  } else if (ph.phase === "intermission") {
    const w = ph.word || turnData.word;
    box.appendChild(el("div", "status-title", "The word was"));
    box.appendChild(el("div", "status-word drawer-word", w || "?"));
  }

  const timer = $("#q-time");
  timer.textContent = Math.ceil(ph.timeLeft) + "s";
  const total =
    ph.phase === "intermission" ? Math.max(1, game.intermission) : game.turnDuration;
  const fill = $("#q-progress");
  fill.style.width = Math.max(0, Math.min(100, (ph.timeLeft / total) * 100)) + "%";
  $("#turn-label").textContent = `Turn ${ph.N + 1}`;

  // guess input availability
  const input = $("#guess-input");
  const btn = $("#guess-btn");
  const canGuess = ph.phase === "drawing" && iGuessedTurn !== ph.N;
  input.disabled = !canGuess;
  btn.disabled = !canGuess;
  input.placeholder = canGuess
    ? "What is the bot drawing?"
    : ph.phase === "drawing"
    ? "You got it — nice! 🎉"
    : "Wait for the next drawing…";
}

function renderChat() {
  const list = $("#chat-list");
  list.innerHTML = "";
  if (!chatLog.length) {
    list.appendChild(el("div", "muted small center", "Guesses appear here. What's the bot drawing?"));
    return;
  }
  chatLog.forEach((m) => {
    const row = el("div", "chat-msg " + (m.kind || ""));
    if (m.kind === "correct") {
      row.innerHTML = `<b>${escapeHtml(m.from)}</b> got it! +${m.points}`;
    } else if (m.kind === "system") {
      row.textContent = m.text;
    } else {
      row.innerHTML = `<b>${escapeHtml(m.from)}:</b> ${escapeHtml(m.text)}`;
    }
    list.appendChild(row);
  });
  list.scrollTop = list.scrollHeight;
}

function pushChat(m) {
  chatLog.push(m);
  if (chatLog.length > 60) chatLog = chatLog.slice(-60);
  renderChat();
}

// ── actions ─────────────────────────────────────────────────────────────────
async function sendGuess() {
  const input = $("#guess-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  const N = currentTurn();
  const res = await fetch("/api/guess", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid: me.id, turn: N, text }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.correct) {
    iGuessedTurn = N;
    me.score = data.score ?? me.score;
    pushChat({ from: me.username, kind: "correct", points: data.points });
    renderMe();
    renderStatus(computePhase());
  } else if (data.error) {
    pushChat({ from: "system", kind: "system", text: data.error });
  } else {
    pushChat({ from: me.username, kind: "normal", text });
  }
}

async function ensureWord(N) {
  if (ensurePosted) return;
  ensurePosted = true;
  try {
    await fetch("/api/ensure-word", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turn: N }),
    });
  } catch (e) {
    console.warn("[vv] ensure-word failed:", e);
    ensurePosted = false;
  }
}

// ── data / watchers ─────────────────────────────────────────────────────────
async function joinArena() {
  const res = await fetch("/api/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: me.id, username: me.username, avatarUrl: me.avatarUrl }),
  });
  if (!res.ok) throw new Error("join failed: " + res.status);
  const data = await res.json();
  if (data.game?.anchor) {
    game = { ...GAME_DEFAULTS, ...data.game };
    players = data.players || {};
    me.score = players[me.id]?.score || 0;
  }
  return data;
}

function watch(path, onData) {
  const es = dbWatch(path, (rel, data) => onData(rel, data));
  channels.push(es);
  return es;
}

async function loadTurnData(N) {
  const [wordRes, turnRes, guessRes] = await Promise.all([
    dbRead(`${P}/words/${N}`),
    dbRead(`${P}/turns/${N}`),
    dbRead(`${P}/guesses/${N}`),
  ]);
  words[N] = wordRes || null;
  turnData = {
    N,
    word: wordRes || null,
    allGuessedAt: turnRes?.allGuessedAt || null,
    guessed: turnRes?.guessed || {},
    guesses: guessRes || {},
  };
  chatLog = [];
  Object.values(guessRes || {})
    .sort((a, b) => a.at - b.at)
    .slice(-20)
    .forEach((g) => {
      chatLog.push({
        from: players[g.uid]?.username || "Player",
        kind: g.correct ? "correct" : "normal",
        text: g.correct ? "" : g.text,
        points: g.points || 0,
      });
    });
}

function setupWatches() {
  channels.forEach((es) => es.close());
  channels = [];

  watch(`${P}/game`, (rel, data) => {
    if (data && typeof data === "object" && data.anchor) {
      game = { ...GAME_DEFAULTS, ...data };
    }
  });

  watch(`${P}/players`, (rel, data) => {
    if (rel === "/") {
      players = data || {};
    } else {
      const parts = rel.split("/").filter(Boolean);
      const uid = parts[0];
      if (uid) {
        if (!data) delete players[uid];
        else players[uid] = data;
      }
    }
  });

  // word watcher — covers current + next turns
  watch(`${P}/words`, (rel, data) => {
    if (rel === "/") {
      words = data || {};
    } else {
      const N = parseInt(rel.split("/").filter(Boolean)[0], 10);
      if (!isNaN(N)) words[N] = data || null;
    }
    if (turnData.N === currentTurn()) {
      turnData.word = words[turnData.N] || null;
      ensurePosted = false;
      renderStatus(computePhase());
    }
  });
}

function setupTurnWatch(N) {
  turnChannels.forEach((es) => es.close());
  turnChannels = [];
  const w = (path, onData) => {
    const s = dbWatch(path, (rel, data) => onData(rel, data));
    turnChannels.push(s);
    return s;
  };
  w(`${P}/turns/${N}`, (rel, data) => {
    if (rel === "/" || rel === "/allGuessedAt") {
      turnData.allGuessedAt = data?.allGuessedAt ?? data ?? null;
    }
  });
  w(`${P}/guesses/${N}`, (rel, data) => {
    if (rel === "/") {
      turnData.guesses = data || {};
    } else {
      const uid = rel.split("/").filter(Boolean)[0];
      if (uid && data) {
        turnData.guesses[uid] = data;
        const from = players[uid]?.username || "Player";
        if (data.correct) {
          pushChat({ from, kind: "correct", points: data.points || 0 });
        } else {
          pushChat({ from, kind: "normal", text: data.text });
        }
      }
    }
    if (chatLog.length > 80) chatLog = chatLog.slice(-60);
  });
}

// ── heartbeat + clock ───────────────────────────────────────────────────────
async function heartbeat() {
  try {
    await dbUpdate(`${P}/players/${me.id}`, { lastSeen: Date.now(), online: true });
  } catch (e) {
    console.warn("[vv] heartbeat failed:", e);
  }
}

async function syncClock() {
  try {
    const res = await fetch("/api/time");
    const data = await res.json();
    if (data.now) offset = data.now - Date.now();
  } catch (e) {
    console.warn("[vv] clock sync failed:", e);
  }
}

// ── main loop (rAF) ─────────────────────────────────────────────────────────
let lastTurn = -1;

function frame() {
  requestAnimationFrame(frame);
  const ph = computePhase();

  // Turn changed → load new turn, re-watch per-turn data
  if (ph.N !== lastTurn && ph.N >= 0) {
    lastTurn = ph.N;
    iGuessedTurn = -1;
    ensurePosted = false;
    loadTurnData(ph.N).catch((e) => console.warn("[vv] loadTurnData:", e));
    setupTurnWatch(ph.N);
  }

  // The bot needs a word — ask the worker if the turn is fresh
  if (ph.N >= 0 && !words[ph.N] && ph.t >= 1200 && !ensurePosted) {
    ensureWord(ph.N);
  }

  // Canvas: animate the bot's drawing
  if (canvas && ph.phase === "drawing" && ph.word) {
    const t = ph.t / 1000;
    const elapsed = Math.max(0, t - DRAW_START);
    canvas.render(DRAWINGS[ph.word] || null, elapsed, DRAW_END - DRAW_START);
  } else if (canvas && ph.phase === "intermission") {
    // show the finished drawing
    const w = ph.word || turnData.word;
    if (w) canvas.render(DRAWINGS[w] || null, 999, 100);
  } else if (canvas) {
    canvas.clear();
  }

  // DOM updates ~5x/sec
  const tNow = performance.now();
  if (tNow - lastDomUpdate > 200) {
    lastDomUpdate = tNow;
    renderStatus(ph);
    renderLeaderboard();
    renderMe();
  }
}

// ── boot ────────────────────────────────────────────────────────────────────
async function boot() {
  setScreen("loading");
  $("#loading-msg").textContent = "Joining the global arena…";
  try {
    me = { ...(await resolveIdentity()) };
    await syncClock();
    await joinArena();
    renderMe();

    setupWatches();
    const N = currentTurn();
    if (N >= 0) {
      lastTurn = N;
      await loadTurnData(N);
      setupTurnWatch(N);
    }
    canvas = createBotCanvas($("#canvas-host"));

    setInterval(heartbeat, 30000);
    setInterval(syncClock, 60000);
    requestAnimationFrame(frame);

    setScreen("game");
  } catch (e) {
    console.error("[vv] boot failed:", e);
    setScreen("error");
    $("#error-msg").textContent = e.message || String(e);
  }
}

function wireUi() {
  $("#btn-retry").addEventListener("click", () => location.reload());
  $("#guess-form").addEventListener("submit", (e) => {
    e.preventDefault();
    sendGuess();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  wireUi();
  boot();
});
