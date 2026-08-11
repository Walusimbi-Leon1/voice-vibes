# 🎨 Voice Vibes — The Bot Draws, You Guess

> **One global room. A bot that draws. Everyone on Earth guessing together.**
> No rooms, no codes, no waiting for friends — open the game and you're instantly in the world's biggest Pictionary match.

Voice Vibes is a real-time **"bot draws, you guess"** game for **Discord Activities** and the browser. A friendly bot draws a new picture every 70 seconds — stroke by stroke, live on your screen — and you race players from every Discord server to guess it first. Wrong guesses are just chat noise; right guesses score points that stack onto a **permanent global leaderboard**.

## 🌍 How It Works

- **One arena for everyone.** Every player online — from every server, in every timezone — shares the same turn, the same drawing, the same leaderboard.
- **The bot is the artist.** The worker picks a word each turn and the drawing is revealed progressively on everyone's canvas at the same pace. A 🖌️ pen draws real strokes, just like a person would.
- **Turns run themselves.** Turn *n* starts at `anchor + n × 70s`. No host, no start button, join or leave anytime.
- **Join anytime, even alone.** The bot draws for you solo; others drop in mid-turn and guess alongside you.
- **Speed scoring.** First correct guess scores up to 200 points, scaling down as the turn progresses. The persistent leaderboard never resets.
- **Fair hints.** At 35s the bot reveals the first letter; at 50s, the second. Late guesses still score.
- **Server-authoritative.** Every guess is validated by the worker — no client-side score hacking. Scores persist forever in Firebase.

## 🎮 Game Flow

1. Turn starts → the bot "thinks" for a second, then starts drawing.
2. The picture emerges stroke-by-stroke over ~55 seconds while everyone types guesses.
3. Guess right → speed points + a "✅ got it" badge (you're out of that round).
4. Everyone guessed (or time's up) → the word is revealed, 8s breather, next drawing.
5. Scores roll into the global leaderboard permanently.

## 🛠️ Tech Stack

- **Cloudflare Workers** — serves everything: static assets, Discord OAuth exchange, game API, Firebase proxy
- **Firebase Realtime Database** — shared global state (public-writable DB, isolated `vibes/global` namespace)
- **Discord Embedded App SDK 2.5.0** — vendored same-origin (Discord's sandbox blocks external CDNs)
- **100 hand-crafted vector drawings** — the bot's art gallery, rendered with progressive stroke animation
- **Vanilla JS, zero build dependencies** — ~450 KB total

## 🎧 Adding to Discord

The game is already deployed and running:

**Live URL:** https://voice-vibes.walusimbileon2.workers.dev
**Discord Application ID:** `1536606953835470859`

### Developer Portal setup (one-time)

1. Go to **https://discord.com/developers/applications** → the **Voice Vibes** app.
2. **General Information**:
   - **Terms of Service URL:** `https://voice-vibes.walusimbileon2.workers.dev/terms`
   - **Privacy Policy URL:** `https://voice-vibes.walusimbileon2.workers.dev/privacy`
   - **Support/Developer link:** `https://walusimbi-leon1.github.io/voice-support/`
3. **OAuth2** → add redirect: `https://voice-vibes.walusimbileon2.workers.dev` (exact, no trailing slash).
4. **General Information → Links → Activity URL:** `https://voice-vibes.walusimbileon2.workers.dev/`
5. Copy the **Client ID** and **Client Secret** for deployments.

Then launch it in any server: **voice channel → Activities (🎮) → Voice Vibes**.

> No socket or domain configuration is needed — the sandbox only ever talks to its own origin.

## 🚀 Deploying

```bash
# 1. Build (inlines src/* into dist/worker.js and injects the bot vocabulary)
node build.js

# 2. Deploy with secrets from environment (never committed to the repo)
CF_API_TOKEN=*** \
DISCORD_CLIENT_ID=1536606953835470859 \
DISCORD_CLIENT_SECRET=*** \
bash deploy.sh
```

### Environment / Secrets

| Variable | Where | Description |
|---|---|---|
| `DISCORD_CLIENT_ID` | deploy.sh env → worker var | Discord Application ID (public — `1536606953835470859`) |
| `DISCORD_CLIENT_SECRET` | deploy.sh env → worker **secret** | Discord App Secret (private — never commit) |
| `REDIRECT_URI` | deploy.sh (auto) | `https://voice-vibes.walusimbileon2.workers.dev` |
| `FB_HOST` | deploy.sh (auto) | Firebase RTDB host |

Authorization URL (confidential OAuth flow): `https://discord.com/oauth2/authorize?client_id=1536606953835470859&response_type=code&redirect_uri=https%3A%2F%2Fvoice-vibes.walusimbileon2.workers.dev&scope=identify`

## 📁 Project Structure

```
├── worker.js            # Cloudflare Worker: assets, /api/*, /firebase proxy
├── build.js             # inlines src/* → dist/worker.js (static map + bot words)
├── deploy.sh            # uploads worker + sets secrets via API
├── wrangler.toml        # config reference (vars documented above)
└── src/
    ├── index.html       # game UI
    ├── style.css
    ├── app.js           # global game engine (deterministic time-sliced turns)
    ├── canvas.js        # bot canvas renderer (progressive stroke reveal)
    ├── drawings.js      # 🎨 100 vector drawings (the bot's art gallery)
    ├── discord.js       # Discord SDK integration (Bible Trivia pattern)
    ├── firebase.js      # /firebase proxy client (REST + SSE)
    ├── support.js       # external-link opener (openExternalLink in Discord)
    ├── privacy.html / terms.html
    └── vendor/discord-sdk.mjs  # vendored @discord/embedded-app-sdk@2.5.0
```

## 🔒 Security

- `DISCORD_CLIENT_SECRET` never touches the repo — set via deploy.sh from the environment as an encrypted Worker secret.
- Scoring is **server-authoritative**: only the worker writes words, guesses, and scores.
- All game traffic flows through the same-origin `/firebase` proxy (Discord sandbox blocks direct firebaseio.com calls).

## 📄 License

Private — SGSS
