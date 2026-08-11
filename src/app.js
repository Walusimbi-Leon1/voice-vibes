/**
 * Voice Vibes — global Pictionary game engine.
 *
 * GLOBAL ROOM MODEL (Bible Trivia pattern):
 *  - There is ONE room for everyone on the planet. No room codes.
 *  - Turns are deterministic and time-sliced:
 *      turn N starts at  anchor + N * turnDuration
 *      drawer(N)        = sortedOnline[N % len]
 *    Every client computes the same turn/drawer from shared state — no
 *    host, no "start game" button.
 *  - The worker is the only writer of words/guesses/anchors, so scoring
 *    is server-authoritative and leaderboard scores persist forever.
 *  - Join anytime; if the arena is empty the worker restarts the clock so
 *    you instantly become the drawer of a fresh turn.
 *
 * Data (RTDB via same-origin /firebase proxy):
 *  vibes/global/game              = { anchor, turnDuration, pickDuration, intermission, onlineWindow }
 *  vibes/global/words/<turn>      = "pizza"
 *  vibes/global/turns/<turn>      = { allGuessedAt?, guessed: {<uid>: true} }
 *  vibes/global/guesses/<turn>/<uid> = { text, at, correct }
 *  vibes/global/canvas/<turn>/strokes/<id> = { color, size, segments: [{from,to},...] }
 *  vibes/global/players/<uid>     = { id, username, avatarUrl, score, lastSeen, online, joinedAt }
 */

import { initDiscord, isDiscord } from "./discord.js";
import { dbRead, dbWrite, dbUpdate, dbDelete, dbWatch } from "./firebase.js";
import { pickWords, maskWord } from "./words.js";
import { createCanvas } from "./canvas.js";

const P = "vibes/global";
const NS = "bible-game-21-default-rtdb";

const GAME_DEFAULTS = {
  anchor: null,
  turnDuration: 70,
  pickDuration: 15,
  intermission: 8,
  onlineWindow: 120,
};

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
let words = {};        // word cache for nearby turns
let offset = 0;        // server clock offset (ms)
let clockOffsetKnown = false;
let canvas = null;
let appliedStrokes = new Set();
let localStrokeIds = new Set();
let strokeBuffer = [];
let strokeFlushTimer = null;
let autoPickPosted = false;
let loadingTurn = false;
let channels = [];
let phase = "loading";
let wordChoices = null;

function now() {
  return Date.now() + offset;
}

function sortedOnline() {
  const cutoff = now() - (game.onlineWindow || 120) * 1000;
  return Object.values(players)
    .filter((p) => p && (p.lastSeen || 0) > cutoff)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function currentTurn() {
  if (!game.anchor) return -1;
  return Math.floor((now() - game.anchor) / (game.turnDuration * 1000));
}

function turnStart(N) {
  return game.anchor + N * game.turnDuration * 1000;
}

function drawerFor(N) {
  const online = sortedOnline();
  if (!online.length) return null;
  return online[((N % online.length) + online.length) % online.length];
}

// ── phase derivation (deterministic, all clients) ───────────────────────────
function computePhase() {
  const N = currentTurn();
  if (N < 0) return { N, phase: "idle" };
  const word = words[N] || null;
  const t = now() - turnStart(N);
  const T = game.turnDuration * 1000;
  const pickMs = game.pickDuration * 1000;
  const allGuessedAt = turnData.N === N ? turnData.allGuessedAt : null;

  let phase;
  if (!word && t < pickMs) phase = "picking";
  else if (!word) phase = "picking-timeout";
  else if (allGuessedAt) phase = "intermission";
  else if (t < T) phase = "drawing";
  else phase = "intermission";

  let timeLeft = 0;
  if (phase === "picking" || phase === "picking-timeout") timeLeft = Math.max(0, (pickMs - t) / 1000);
  else if (phase === "drawing") {
    const end = allGuessedAt || turnStart(N) + T;
    timeLeft = Math.max(0, (end - now()) / 1000);
  } else if (phase === "intermission") {
    const end = turnStart(N + 1);
    timeLeft = Math.max(0, (end - now()) / 1000);
  }

  return { N, phase, timeLeft, word, t, T };
}

// ── UI rendering ────────────────────────────────────────────────────────────
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

function avatarHtml(p, size) {
  const s = size || 30;
  if (p.avatarUrl) {
    return `<img class="avatar" style="width:${s}px;height:${s}px" src="${escapeHtml(p.avatarUrl)}" alt="">`;
  }
  return `<div class="avatar avatar-fallback" style="width:${s}px;height:${s}px;background:${hashColor(p.id)}">${escapeHtml(initials(p.username))}</div>`;
}

function hashColor(id) {
  const palette = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16"];
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
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
  const top = all.slice(0, 10);
  const list = $("#lb-list");
  list.innerHTML = "";
  if (!all.length) {
    list.appendChild(el("p", "muted small", "No players yet — be the first!"));
    return;
  }
  top.forEach((p, i) => {
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
  const myRank = all.findIndex((p) => p.id === me.id);
  $("#my-rank").textContent =
    myRank >= 0
      ? `Your rank: #${myRank + 1} of ${all.length} · ⭐ ${me.score} pts`
      : "Join the arena to rank up!";
}

function renderStatus(ph) {
  const box = $("#status-box");
  box.innerHTML = "";
  const drawer = drawerFor(ph.N);
  const isDrawer = me.id === drawer?.id;

  if (ph.phase === "idle") {
    box.appendChild(el("div", "status-title", "🌍 Global Arena"));
    box.appendChild(el("div", "muted", "The world's drawing room. Waiting for players…"));
    return;
  }

  const roundEl = el("div", "status-round", `Turn ${ph.N + 1}`);
  box.appendChild(roundEl);

  if (ph.phase === "picking") {
    box.appendChild(el("div", "status-title", isDrawer ? "Pick a word to draw!" : `${drawer?.username || "Someone"} is picking a word…`));
    if (isDrawer && !wordChoices) {
      wordChoices = pickWords(3);
      const choicesRow = el("div", "choices");
      wordChoices.forEach((w) => {
        const b = el("button", "choice-btn", w);
        b.addEventListener("click", () => pickWord(w));
        choicesRow.appendChild(b);
      });
      box.appendChild(choicesRow);
    }
  } else if (ph.phase === "picking-timeout") {
    box.appendChild(el("div", "status-title", isDrawer ? "Hurry! Pick a word" : `${drawer?.username || "The drawer"} missed the pick — choosing one for them…`));
    if (isDrawer && !wordChoices) {
      wordChoices = pickWords(3);
      const choicesRow = el("div", "choices");
      wordChoices.forEach((w) => {
        const b = el("button", "choice-btn", w);
        b.addEventListener("click", () => pickWord(w));
        choicesRow.appendChild(b);
      });
      box.appendChild(choicesRow);
    }
  } else if (ph.phase === "drawing") {
    const word = ph.word;
    const wEl = el("div", "status-word");
    if (isDrawer) {
      wEl.textContent = word;
      wEl.className += " drawer-word";
    } else {
      wEl.textContent = maskWord(word);
      wEl.className += " masked-word";
    }
    box.appendChild(el("div", "status-title", isDrawer ? "Draw this!" : `${drawer?.username || "Someone"} is drawing`));
    box.appendChild(wEl);
    if (!isDrawer) box.appendChild(el("div", "muted small", `${word.length} letters`));
  } else if (ph.phase === "intermission") {
    const lastWord = ph.word || turnData.word;
    box.appendChild(el("div", "status-title", "The word was"));
    box.appendChild(el("div", "status-word drawer-word", lastWord || "?"));
    box.appendChild(el("div", "muted small", "Next turn in a moment…"));
  }

  const timer = $("#q-time");
  timer.textContent = Math.ceil(ph.timeLeft) + "s";
  const fill = $("#q-progress");
  const total =
    ph.phase === "drawing"
      ? game.turnDuration
      : ph.phase === "intermission"
      ? Math.max(1, game.intermission)
      : game.pickDuration;
  fill.style.width = Math.max(0, Math.min(100, (ph.timeLeft / total) * 100)) + "%";
  $("#turn-label").textContent = `Turn ${ph.N + 1}`;
}

function renderChat() {
  const list = $("#chat-list");
  list.innerHTML = "";
  const msgs = chatLog;
  if (!msgs.length) {
    list.appendChild(el("div", "muted small center", "Guesses appear here. Get the word right to score!"));
    return;
  }
  msgs.forEach((m) => {
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

let chatLog = [];

function pushChat(m) {
  chatLog.push(m);
  if (chatLog.length > 60) chatLog = chatLog.slice(-60);
  renderChat();
}

// ── canvas wiring ───────────────────────────────────────────────────────────
function makeCanvas() {
  if (canvas) return;
  canvas = createCanvas($("#canvas-host"), {
    drawable: () => {
      const ph = computePhase();
      const drawer = drawerFor(ph.N);
      return ph.phase === "drawing" && me.id === drawer?.id;
    },
    onStroke: (seg) => {
      strokeBuffer.push(seg);
      if (!strokeFlushTimer) {
        strokeFlushTimer = setTimeout(flushStrokes, 300);
      }
    },
    onClear: () => {
      const N = currentTurn();
      dbWrite(`${P}/canvas/${N}/clear`, Date.now()).catch(() => {});
    },
  });
  canvas.refresh();
}

function flushStrokes() {
  strokeFlushTimer = null;
  if (!strokeBuffer.length) return;
  const segs = strokeBuffer;
  strokeBuffer = [];
  const N = currentTurn();
  const id = crypto.randomUUID();
  localStrokeIds.add(id);
  dbWrite(`${P}/canvas/${N}/strokes/${id}`, { segments: segs, at: Date.now() }).catch((e) => {
    console.warn("[vv] stroke write failed:", e);
    // restore to buffer for retry on next flush cycle
    strokeBuffer = segs.concat(strokeBuffer);
  });
}

function clearCanvasUi() {
  canvas?.clearRemote();
  appliedStrokes = new Set();
  localStrokeIds = new Set();
}

// ── actions ─────────────────────────────────────────────────────────────────
async function pickWord(word) {
  const N = currentTurn();
  const res = await fetch("/api/pick-word", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid: me.id, turn: N, word }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.warn("[vv] pick-word failed:", data.error);
    return;
  }
  wordChoices = null;
}

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
    pushChat({ from: me.username, kind: "correct", points: data.points, text: "" });
    me.score = (data.score ?? me.score);
    renderMe();
  } else if (data.error) {
    pushChat({ from: "system", kind: "system", text: data.error });
  } else {
    pushChat({ from: me.username, kind: "normal", text });
  }
}

async function autoPickIfNeeded(ph) {
  if (ph.phase !== "picking-timeout" || autoPickPosted) return;
  autoPickPosted = true;
  try {
    await fetch("/api/auto-pick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turn: ph.N }),
    });
  } catch (e) {
    console.warn("[vv] auto-pick failed:", e);
  }
}

// ── data loading / watching ─────────────────────────────────────────────────
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
  const es = dbWatch(path, (rel, data) => {
    onData(rel, data, es);
  });
  channels.push(es);
  return es;
}

async function loadTurnData(N) {
  if (loadingTurn) return;
  loadingTurn = true;
  try {
    const [wordRes, turnRes, guessRes, strokeRes] = await Promise.all([
      dbRead(`${P}/words/${N}`),
      dbRead(`${P}/turns/${N}`),
      dbRead(`${P}/guesses/${N}`),
      dbRead(`${P}/canvas/${N}/strokes`),
    ]);
    words[N] = wordRes || null;
    turnData = {
      N,
      word: wordRes || null,
      allGuessedAt: turnRes?.allGuessedAt || null,
      guessed: turnRes?.guessed || {},
      guesses: guessRes || {},
    };
    // Replay existing strokes
    appliedStrokes = new Set();
    localStrokeIds = new Set();
    const strokes = strokeRes || {};
    Object.keys(strokes)
      .sort()
      .forEach((id) => {
        const s = strokes[id];
        if (s?.segments?.length) {
          s.segments.forEach((seg) => canvas?.drawRemoteStroke(seg));
          appliedStrokes.add(id);
        }
      });
    // Seed chat from recent guesses
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
  } finally {
    loadingTurn = false;
  }
}

function clearCanvasForNewTurn() {
  canvas?.clearRemote();
  appliedStrokes = new Set();
  localStrokeIds = new Set();
}

// ── main loop ───────────────────────────────────────────────────────────────
function tick() {
  const ph = computePhase();

  // Turn changed? Load new turn data + resubscribe.
  if (ph.N !== turnData.N) {
    wordChoices = null;
    autoPickPosted = false;
    clearCanvasForNewTurn();
    loadTurnData(ph.N).catch((e) => console.warn("[vv] loadTurnData:", e));
    // (re)subscribe to per-turn streams for the new turn
    setupTurnWatches(ph.N);
  }

  if (ph.phase === "picking" || ph.phase === "picking-timeout") {
    autoPickIfNeeded(ph);
  }

  renderStatus(ph);
  renderLeaderboard();
  renderMe();
  canvas?.refresh();
}

function setupTurnWatches(N) {
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

  watch(`${P}/words/${N}`, (rel, data) => {
    words[N] = data || null;
    if (data && turnData.N === N) {
      turnData.word = data;
      wordChoices = null;
      // If we just picked (drawer) — refresh status immediately
      renderStatus(computePhase());
    }
  });

  watch(`${P}/turns/${N}`, (rel, data) => {
    if (rel === "/" || rel === "/allGuessedAt") {
      turnData.allGuessedAt = data?.allGuessedAt ?? data ?? null;
    } else if (rel.startsWith("/guessed")) {
      turnData.guessed = { ...(turnData.guessed || {}), ...(data || {}) };
    }
  });

  watch(`${P}/guesses/${N}`, (rel, data) => {
    if (rel === "/") {
      turnData.guesses = data || {};
    } else {
      const uid = rel.split("/").filter(Boolean)[0];
      if (uid && data) {
        turnData.guesses[uid] = data;
        const g = data;
        const from = players[uid]?.username || "Player";
        if (g.correct) {
          pushChat({ from, kind: "correct", points: g.points || 0 });
        } else {
          pushChat({ from, kind: "normal", text: g.text });
        }
      }
    }
    // cap chat noise
    if (chatLog.length > 80) chatLog = chatLog.slice(-60);
  });

  watch(`${P}/canvas/${N}/strokes`, (rel, data) => {
    if (rel === "/") return; // full snapshot — ignore (we load via GET)
    const id = rel.split("/").filter(Boolean)[0];
    if (!id || appliedStrokes.has(id) || localStrokeIds.has(id)) return;
    if (data?.segments?.length) {
      data.segments.forEach((seg) => canvas?.drawRemoteStroke(seg));
      appliedStrokes.add(id);
    }
  });

  watch(`${P}/canvas/${N}/clear`, (rel, data) => {
    if (rel === "/") {
      canvas?.clearRemote();
      appliedStrokes = new Set();
    }
  });
}

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
    if (data.now) {
      offset = data.now - Date.now();
      clockOffsetKnown = true;
    }
  } catch (e) {
    console.warn("[vv] clock sync failed:", e);
  }
}

// ── boot ────────────────────────────────────────────────────────────────────
async function boot() {
  setScreen("loading");
  $("#loading-msg").textContent = "Joining the global arena…";
  try {
    const identity = await resolveIdentity();
    me = { ...identity };
    await syncClock();
    const data = await joinArena();
    game = { ...GAME_DEFAULTS, ...(data.game || {}) };
    players = data.players || {};
    me.score = players[me.id]?.score || 0;

    renderMe();
    setupTurnWatches(currentTurn());
    const N = currentTurn();
    if (N >= 0) await loadTurnData(N);
    makeCanvas();
    canvas.refresh();

    // beat: heartbeat + clock resync
    setInterval(heartbeat, 30000);
    setInterval(syncClock, 60000);
    setInterval(tick, 400);
    tick();

    setScreen("game");
    $("#loading-msg").textContent = "Connecting…";
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
