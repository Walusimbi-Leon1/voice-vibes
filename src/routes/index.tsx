import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Game } from "@/components/game/Game";
import { initDiscord } from "@/lib/discord";
import { Palette, Sparkles } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Index,
});

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function getPlayerId() {
  if (typeof window === "undefined") return "anon";
  let id = localStorage.getItem("dd_player_id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("dd_player_id", id);
  }
  return id;
}

function Index() {
  const [playerId, setPlayerId] = useState<string>("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [joined, setJoined] = useState<string | null>(null);

  useEffect(() => {
    setPlayerId(getPlayerId());
    const savedName = localStorage.getItem("dd_player_name");
    if (savedName) setName(savedName);
    // Try to init Discord; if running as Activity, seed the room code from instance
    initDiscord().then((d) => {
      if (d?.instanceId) {
        setCode(d.instanceId.slice(0, 5).toUpperCase());
        if (d.username && !savedName) setName(d.username);
      }
    });
  }, []);

  const persistName = (n: string) => {
    setName(n);
    if (n) localStorage.setItem("dd_player_name", n);
  };

  const join = (roomCode: string) => {
    if (!name.trim() || !roomCode.trim()) return;
    setJoined(roomCode.toUpperCase());
  };

  if (joined && playerId) {
    return (
      <Game
        roomCode={joined}
        playerId={playerId}
        playerName={name.trim().slice(0, 20)}
        onLeave={() => setJoined(null)}
      />
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-100 via-purple-50 to-pink-100 p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-lg mb-3">
            <Palette className="w-8 h-8" />
          </div>
          <h1 className="text-4xl font-bold tracking-tight bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
            Doodle Dash
          </h1>
          <p className="text-sm text-muted-foreground mt-1 flex items-center justify-center gap-1">
            <Sparkles className="w-3.5 h-3.5" />
            Draw, guess, laugh — together on voice
          </p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl border p-6 space-y-4">
          <div>
            <label className="text-sm font-medium block mb-1.5">Your name</label>
            <Input
              value={name}
              onChange={(e) => persistName(e.target.value)}
              placeholder="e.g. Picasso"
              maxLength={20}
            />
          </div>

          <div className="space-y-2">
            <Button
              className="w-full"
              size="lg"
              disabled={!name.trim()}
              onClick={() => join(randomCode())}
            >
              Create New Room
            </Button>

            <div className="flex items-center gap-2 my-2">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs text-muted-foreground">OR JOIN</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            <div className="flex gap-2">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ROOM CODE"
                maxLength={5}
                className="font-mono tracking-widest text-center uppercase"
              />
              <Button
                variant="secondary"
                disabled={!name.trim() || code.length < 4}
                onClick={() => join(code)}
              >
                Join
              </Button>
            </div>
          </div>
        </div>

        <p className="text-xs text-muted-foreground text-center mt-4">
          Up to 10 players · 3 rounds · best with voice chat
        </p>
      </div>
    </div>
  );
}
