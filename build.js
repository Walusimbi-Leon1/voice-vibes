#!/usr/bin/env node
/**
 * Voice Vibes — build script
 * Inlines all client assets (src/* + vendored Discord SDK) into
 * dist/worker.js as a STATIC map, ready for Cloudflare Workers deploy.
 *
 * Usage: node build.js   → writes dist/worker.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");

const FILES = {
  "index.html": "index.html",
  "style.css": "style.css",
  "app.js": "app.js",
  "canvas.js": "canvas.js",
  "discord.js": "discord.js",
  "drawings.js": "drawings.js",
  "firebase.js": "firebase.js",
  "support.js": "support.js",
  "vendor/discord-sdk.mjs": "vendor/discord-sdk.mjs",
  "privacy.html": "privacy.html",
  "terms.html": "terms.html",
};

function read(name) {
  return fs.readFileSync(path.join(SRC, name), "utf8");
}

let worker = fs.readFileSync(path.join(ROOT, "worker.js"), "utf8");

for (const [key, file] of Object.entries(FILES)) {
  const placeholder = `__${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}__`;
  const content = read(file);
  if (!worker.includes(placeholder)) {
    console.error(`Missing placeholder ${placeholder} in worker.js`);
    process.exit(1);
  }
  // JSON.stringify gives us a safe JS string literal for every file.
  // (Must use a replacement FUNCTION — a string replacement would interpret
  //  $& / $' sequences inside the bundle as special patterns.)
  worker = worker.replace(placeholder, () => JSON.stringify(content));
}

// Inject the bot's vocabulary (drawing keys) into the worker's WORDS const.
const drawingsSrc = read("drawings.js");
const wordsMatch = drawingsSrc.match(/export const DRAWINGS = \{([\s\S]*?)\n\};/);
if (!wordsMatch) {
  console.error("Could not parse drawings.js DRAWINGS keys");
  process.exit(1);
}
const botWords = [...wordsMatch[1].matchAll(/^  "?([\w\s-]+?)"?: \[/gm)].map((m) => m[1].trim());
if (!worker.includes("__DRAWING_WORDS__")) {
  console.error("Missing __DRAWING_WORDS__ placeholder in worker.js");
  process.exit(1);
}
worker = worker.replace("__DRAWING_WORDS__", () => JSON.stringify(botWords));
console.log(`Bot vocabulary: ${botWords.length} words`);

// Any leftover placeholders?
const leftovers = worker.match(/__[A-Z0-9_]+__/g) || [];
if (leftovers.length) {
  console.error("Unresolved placeholders:", leftovers);
  process.exit(1);
}

fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, "worker.js"), worker);
const kb = (worker.length / 1024).toFixed(1);
console.log(`Built dist/worker.js (${kb} KB)`);
