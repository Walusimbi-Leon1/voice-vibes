# 🎨 Voice Vibes (YouDraw)

> A real-time multiplayer Pictionary / drawing game for Discord Activities and the browser.

Draw, guess, and race the clock in a battle of creativity and speed. Up to 10 players per room. 3 rounds of drawing and guessing with speed-based scoring.

## 🎮 How It Works

1. **Create or join a room** — share the 5-character room code with friends
2. **Drawer picks a word** — 3 random choices (pizza, dragon, castle, ninja, etc.)
3. **Drawer draws on the canvas** while everyone guesses
4. **Speed bonus scoring** — guess faster = more points. Drawer also earns points when someone guesses correctly
5. **3 rounds** — 70 seconds per turn. Top scorer wins!

Play inside a Discord voice channel as an Activity, or directly in your browser.

## ✨ Features

- 🖌️ **Real-time drawing canvas** — smooth pointer-based drawing with color picker, brush sizes, and eraser
- 🧠 **Speed-based scoring** — faster guesses earn more points (up to 200 points per correct guess)
- 👥 **Up to 10 players** per room with live presence tracking
- 🏆 **Live leaderboard** — see scores update in real-time
- 💬 **In-game chat** — guess and chat alongside the action
- 🎧 **Discord Activities** — play directly inside a voice channel
- 🌐 **Browser support** — works as a standalone web app too

## 🛠️ Tech Stack

- **React 19 + TypeScript**
- **TanStack Start** (React Router framework + SSR)
- **Supabase** (real-time presence, broadcast, and database)
- **Discord Embedded App SDK** (Discord Activities integration)
- **Cloudflare Workers** (deployment server)
- **Tailwind CSS v4 + shadcn/ui** (styling)

## 🚀 Deployment

### Cloudflare Workers

```bash
# Build & deploy to Cloudflare Workers
npm run deploy:cf
```

### Cloudflare Pages

```bash
# Build & deploy to Cloudflare Pages
npm run deploy:pages
```

### Environment Variables

Set these in your Cloudflare dashboard (Workers & Pages → your project → Settings → Variables):

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Your Supabase anon/public key |
| `VITE_SUPABASE_URL` | Same as SUPABASE_URL (client-side) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Same as SUPABASE_PUBLISHABLE_KEY (client-side) |
| `VITE_SUPABASE_PROJECT_ID` | Your Supabase project ID |
| `VITE_DISCORD_CLIENT_ID` | (Optional) Your Discord app client ID for Activities |

> **Note:** The Supabase anon key is safe to expose — it's sent to every browser. Real security comes from Supabase Row-Level Security (RLS) policies.

## 🧪 Development

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## 🏗️ Project Structure

```
src/
├── components/
│   ├── game/
│   │   ├── Game.tsx        # Main game logic & UI
│   │   └── Canvas.tsx      # Drawing canvas component
│   └── ui/                 # shadcn/ui components
├── integrations/
│   └── supabase/
│       ├── client.ts       # Supabase client (browser)
│       ├── client.server.ts # Supabase admin client (server-only)
│       ├── auth-middleware.ts
│       └── auth-attacher.ts
├── lib/
│   ├── discord.ts          # Discord SDK integration
│   ├── words.ts            # Word list for the game
│   └── error-capture.ts    # SSR error handling
├── routes/
│   ├── __root.tsx          # Root layout with meta tags
│   └── index.tsx           # Home page & lobby
├── server.ts               # Cloudflare Workers entry point
└── start.ts                # TanStack Start configuration
```

## 📝 Word List

80+ fun words spanning categories like food, animals, objects, fantasy, and more — randomized each game.

## 🔒 Security

- Supabase service role key is NEVER in the repo — set via Cloudflare Workers secrets
- Discord SDK initialization is optional and fails gracefully
- Real-time game state is managed server-side via Supabase Realtime

## 📄 License

Private — SKSS
