# 🎨 Voice Vibes — Global Draw & Guess

> **The whole world plays in ONE room.** Draw, guess, and climb the persistent leaderboard with players from every Discord server — no invites, no room codes, no waiting for friends.

A real-time global Pictionary game for **Discord Activities** and the browser, built with the proven Bible Trivia architecture: everything same-origin through a Cloudflare Worker, so it runs inside Discord's Activity sandbox with zero configuration.

## 🌍 How the Global Room Works

- **One arena for everyone.** There are no rooms or codes — every player online is in the same game.
- **Turns run themselves.** Turn *n* starts at `anchor + n × 70s`, and the drawer is chosen deterministically: `sortedOnline[n % playerCount]`. No host, no "Start" button.
- **Join anytime, even alone.** If the arena is empty for an hour, the clock restarts on your join — you instantly become the drawer of a fresh turn, and others who join mid-turn guess your drawing.
- **Persistent leaderboard.** Scores are server-authoritative (the worker validates every guess and awards points — no client-side cheating) and stored forever in Firebase. Your Discord identity carries your score across every server and session.
- **Speed scoring.** Guess faster = more points (up to 200). The drawer earns +25 per correct guess.

## 🎮 Game Flow

1. Turn starts → the drawer gets 3 word choices (15s to pick, auto-picked if AFK).
2. Drawer draws on the canvas while everyone guesses in real time.
3. First correct guess scores most; when everyone's guessed (or 70s is up) the word is revealed.
4. Next turn starts automatically. Score totals roll into the global leaderboard.

## 🛠️ Tech Stack

- **Cloudflare Workers** — serves everything: static assets, Discord OAuth exchange, game API, Firebase proxy
- **Firebase Realtime Database** — shared global state (same public-writable DB as Bible Trivia, isolated `vibes/global` namespace)
- **Discord Embedded App SDK 2.5.0** — vendored same-origin (Discord's sandbox blocks external CDNs)
- **Vanilla JS** — zero build dependencies, ~200 KB total

## 🚀 Deploy

```bash
# 1. Build (inlines src/* into dist/worker.js)
node build.js

# 2. Deploy with secrets from environment (never committed)
CF_API_TOKEN=... \
DISCORD_CLIENT_ID=1333998470524768276 \
DISCORD_CLIENT_SECRET=... \
bash deploy.sh
```

Live: **https://voice-vibes.walusimbileon2.workers.dev**

### Environment / Secrets

| Variable | Where | Description |
|---|---|---|
| `DISCORD_CLIENT_ID` | deploy.sh env → worker var | Discord Application ID (public) |
| `DISCORD_CLIENT_SECRET` | deploy.sh env → worker **secret** | Discord App Secret (private) |
| `REDIRECT_URI` | deploy.sh (auto) | Must match Developer Portal exactly |
| `FB_HOST` | deploy.sh (auto) | Firebase RTDB host |

## 🎧 Adding to Discord (Developer Portal)

1. Go to **https://discord.com/developers/applications** → **New Application** → name it **Voice Vibes**.
2. **General Information** → set the icon/banner, and add these links (required for listing):
   - **Terms of Service URL:** `https://voice-vibes.walusimbileon2.workers.dev/terms`
   - **Privacy Policy URL:** `https://voice-vibes.walusimbileon2.workers.dev/privacy`
   - **Support/Developer link:** `https://walusimbi-leon1.github.io/voice-support/`
3. **OAuth2** → add a redirect: `https://voice-vibes.walusimbileon2.workers.dev` (exact, no trailing slash).
4. **General Information → Links → Activity URL:** `https://voice-vibes.walusimbileon2.workers.dev/`
5. Copy the **Application ID** (client ID) and **Client Secret** → deploy with them as env vars.
6. In a server: **voice channel → Activities (🎮) → Voice Vibes** — or use the "Try it out" button on the app page.

The game works with **no socket/domain configuration** — the sandbox only ever talks to its own origin, so no Developer Portal network settings are needed.

## 📁 Project Structure

```
├── worker.js            # Cloudflare Worker: assets, /api/*, /firebase proxy
├── build.js             # inlines src/* → dist/worker.js (static map)
├── deploy.sh            # uploads worker + sets secrets via API
├── wrangler.toml        # config reference (vars documented above)
└── src/
    ├── index.html       # game UI
    ├── style.css
    ├── app.js           # global game engine (deterministic time-sliced turns)
    ├── canvas.js        # drawing canvas (pointer → logical coords → strokes)
    ├── discord.js       # Discord SDK integration (Bible Trivia pattern)
    ├── firebase.js      # /firebase proxy client (REST + SSE)
    ├── support.js       # external-link opener (openExternalLink in Discord)
    ├── words.js         # word list
    ├── privacy.html / terms.html
    └── vendor/discord-sdk.mjs  # vendored @discord/embedded-app-sdk@2.5.0
```

## 🔒 Security

- `DISCORD_CLIENT_SECRET` never touches the repo — set via deploy.sh from the environment as an encrypted Worker secret.
- Scoring is **server-authoritative**: only the worker writes words, guesses, and scores.
- All game traffic flows through the same-origin `/firebase` proxy (Discord sandbox blocks direct firebaseio.com calls).

## 📄 License

Private — SGSS
