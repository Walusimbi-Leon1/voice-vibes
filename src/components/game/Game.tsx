import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { DrawCanvas, type CanvasHandle, type Stroke } from "@/components/game/Canvas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { pickWords, maskWord } from "@/lib/words";
import { Crown, Pencil, Trophy, Clock, Users } from "lucide-react";

type Player = { id: string; name: string; color: string; score: number; guessed: boolean };
type Phase = "waiting" | "picking" | "drawing" | "intermission" | "ended";
type GameState = {
  phase: Phase;
  round: number;
  totalRounds: number;
  drawerId: string | null;
  word: string | null; // only set on host/drawer
  maskedWord: string;
  wordLength: number;
  endsAt: number | null;
  players: Record<string, Player>;
  turnOrder: string[];
  turnIndex: number;
  lastWord?: string;
};

type ChatMsg = { id: string; from: string; text: string; kind: "normal" | "correct" | "system" };

const COLORS = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#14b8a6"];
const TURN_SECONDS = 70;
const PICK_SECONDS = 15;
const INTERMISSION_SECONDS = 5;
const TOTAL_ROUNDS = 3;

function makeInitial(): GameState {
  return {
    phase: "waiting",
    round: 0,
    totalRounds: TOTAL_ROUNDS,
    drawerId: null,
    word: null,
    maskedWord: "",
    wordLength: 0,
    endsAt: null,
    players: {},
    turnOrder: [],
    turnIndex: 0,
  };
}

export function Game({ roomCode, playerId, playerName, onLeave }: {
  roomCode: string;
  playerId: string;
  playerName: string;
  onLeave: () => void;
}) {
  const [state, setState] = useState<GameState>(makeInitial);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [guess, setGuess] = useState("");
  const [wordChoices, setWordChoices] = useState<string[] | null>(null);
  const [now, setNow] = useState(Date.now());
  const [presenceIds, setPresenceIds] = useState<string[]>([]);

  const channelRef = useRef<RealtimeChannel | null>(null);
  const canvasRef = useRef<CanvasHandle>(null);
  const stateRef = useRef<GameState>(state);
  const isHostRef = useRef(false);
  const turnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presenceIdsRef = useRef<string[]>([]);

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { presenceIdsRef.current = presenceIds; }, [presenceIds]);

  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(i);
  }, []);

  const isHost = useMemo(() => {
    if (presenceIds.length === 0) return false;
    const sorted = [...presenceIds].sort();
    return sorted[0] === playerId;
  }, [presenceIds, playerId]);
  useEffect(() => { isHostRef.current = isHost; }, [isHost]);

  const playerColor = useMemo(() => {
    let h = 0;
    for (const c of playerId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
  }, [playerId]);

  const broadcast = useCallback((event: string, payload: unknown) => {
    channelRef.current?.send({ type: "broadcast", event, payload });
  }, []);

  const broadcastState = useCallback((s: GameState) => {
    const { word, ...publicState } = s;
    broadcast("state", publicState);
  }, [broadcast]);

  const startNextTurn = useCallback(() => {
    if (!isHostRef.current) return;
    const s = { ...stateRef.current };
    if (s.turnOrder.length === 0) return;

    let nextIdx = s.turnIndex + 1;
    let nextRound = s.round;
    if (s.phase === "waiting") {
      nextIdx = 0;
      nextRound = 1;
    } else if (nextIdx >= s.turnOrder.length) {
      nextIdx = 0;
      nextRound = s.round + 1;
    }

    if (nextRound > s.totalRounds) {
      s.phase = "ended";
      s.drawerId = null;
      s.word = null;
      s.endsAt = null;
      stateRef.current = s;
      setState(s);
      broadcastState(s);
      return;
    }

    let attempts = 0;
    while (attempts < s.turnOrder.length && !presenceIdsRef.current.includes(s.turnOrder[nextIdx])) {
      nextIdx = (nextIdx + 1) % s.turnOrder.length;
      attempts++;
    }

    s.round = nextRound;
    s.turnIndex = nextIdx;
    s.drawerId = s.turnOrder[nextIdx];
    s.phase = "picking";
    s.word = null;
    s.maskedWord = "";
    s.wordLength = 0;
    s.endsAt = Date.now() + PICK_SECONDS * 1000;
    Object.values(s.players).forEach((p) => (p.guessed = false));

    stateRef.current = s;
    setState(s);
    broadcastState(s);

    const choices = pickWords(3);
    broadcast("word_choices", { to: s.drawerId, choices });

    if (turnTimerRef.current) clearTimeout(turnTimerRef.current);
    turnTimerRef.current = setTimeout(() => {
      const cur = stateRef.current;
      if (cur.phase === "picking" && cur.drawerId === s.drawerId) {
        hostStartDrawing(choices[Math.floor(Math.random() * choices.length)]);
      }
    }, PICK_SECONDS * 1000);
  }, [broadcast, broadcastState]);

  const hostStartDrawing = useCallback((word: string) => {
    if (!isHostRef.current) return;
    const s = { ...stateRef.current };
    if (s.phase !== "picking") return;
    s.phase = "drawing";
    s.word = word;
    s.maskedWord = maskWord(word);
    s.wordLength = word.length;
    s.endsAt = Date.now() + TURN_SECONDS * 1000;
    Object.values(s.players).forEach((p) => (p.guessed = p.id === s.drawerId));
    stateRef.current = s;
    setState(s);
    broadcastState(s);
    broadcast("clear", {});
    broadcast("word_for_drawer", { to: s.drawerId, word });

    if (turnTimerRef.current) clearTimeout(turnTimerRef.current);
    turnTimerRef.current = setTimeout(() => hostEndTurn(false), TURN_SECONDS * 1000);
  }, [broadcast, broadcastState]);

  const hostEndTurn = useCallback((allGuessed: boolean) => {
    if (!isHostRef.current) return;
    const s = { ...stateRef.current };
    if (s.phase !== "drawing") return;
    const revealed = s.word ?? "";
    s.phase = "intermission";
    s.lastWord = revealed;
    s.endsAt = Date.now() + INTERMISSION_SECONDS * 1000;
    stateRef.current = s;
    setState(s);
    broadcastState(s);
    broadcast("chat", {
      id: crypto.randomUUID(),
      from: "system",
      text: allGuessed ? `Everyone got it! The word was "${revealed}"` : `Time's up! The word was "${revealed}"`,
      kind: "system",
    });
    if (turnTimerRef.current) clearTimeout(turnTimerRef.current);
    turnTimerRef.current = setTimeout(() => startNextTurn(), INTERMISSION_SECONDS * 1000);
  }, [broadcast, broadcastState, startNextTurn]);

  const hostHandleGuess = useCallback((from: string, text: string) => {
    if (!isHostRef.current) return;
    const s = { ...stateRef.current };
    const player = s.players[from];
    if (!player) return;
    const isDrawing = s.phase === "drawing" && s.word;
    const cleaned = text.trim().toLowerCase();
    if (isDrawing && !player.guessed && cleaned === s.word!.toLowerCase()) {
      const timeLeft = Math.max(0, ((s.endsAt ?? 0) - Date.now()) / 1000);
      const points = Math.round(50 + (timeLeft / TURN_SECONDS) * 150);
      const drawerBonus = 25;
      const newPlayers = { ...s.players };
      newPlayers[from] = { ...player, guessed: true, score: player.score + points };
      if (s.drawerId && newPlayers[s.drawerId]) {
        newPlayers[s.drawerId] = { ...newPlayers[s.drawerId], score: newPlayers[s.drawerId].score + drawerBonus };
      }
      s.players = newPlayers;
      stateRef.current = s;
      setState(s);
      broadcastState(s);
      broadcast("chat", {
        id: crypto.randomUUID(),
        from: "system",
        text: `${player.name} guessed the word! +${points}`,
        kind: "correct",
      });
      const eligibles = Object.values(s.players).filter((p) => p.id !== s.drawerId && presenceIdsRef.current.includes(p.id));
      if (eligibles.length > 0 && eligibles.every((p) => p.guessed)) {
        hostEndTurn(true);
      }
    } else {
      let kind: ChatMsg["kind"] = "normal";
      broadcast("chat", { id: crypto.randomUUID(), from: player.name, text, kind });
    }
  }, [broadcast, broadcastState, hostEndTurn]);

  useEffect(() => {
    const channel = supabase.channel(`room:${roomCode}`, {
      config: { presence: { key: playerId }, broadcast: { self: true } },
    });
    channelRef.current = channel;

    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState() as Record<string, Array<{ name: string; color: string }>>;
      const ids = Object.keys(state);
      setPresenceIds(ids);

      const sorted = [...ids].sort();
      const hostNow = sorted[0] === playerId;
      if (hostNow) {
        const s = { ...stateRef.current };
        const newPlayers: Record<string, Player> = {};
        let changed = false;
        for (const id of ids) {
          const meta = state[id]?.[0];
          const existing = s.players[id];
          newPlayers[id] = existing
            ? { ...existing, name: meta?.name ?? existing.name, color: meta?.color ?? existing.color }
            : { id, name: meta?.name ?? "Player", color: meta?.color ?? "#888", score: 0, guessed: false };
          if (!existing) changed = true;
        }
        for (const id of Object.keys(s.players)) {
          if (!newPlayers[id]) { changed = true; }
        }
        if (changed || Object.keys(newPlayers).length !== Object.keys(s.players).length) {
          s.players = newPlayers;
          const present = ids.filter((i) => newPlayers[i]);
          const kept = s.turnOrder.filter((i) => present.includes(i));
          const additions = present.filter((i) => !kept.includes(i));
          s.turnOrder = [...kept, ...additions];
          stateRef.current = s;
          setState(s);
          broadcastState(s);
        }
      }
    });

    channel.on("broadcast", { event: "state" }, ({ payload }) => {
      if (isHostRef.current) return;
      const incoming = payload as Omit<GameState, "word">;
      setState((prev) => ({ ...prev, ...incoming, word: prev.word }));
    });

    channel.on("broadcast", { event: "stroke" }, ({ payload }) => {
      const p = payload as { from: string; stroke: Stroke };
      if (p.from === playerId) return;
      canvasRef.current?.drawRemoteStroke(p.stroke);
    });

    channel.on("broadcast", { event: "clear" }, () => {
      canvasRef.current?.clearRemote();
    });

    channel.on("broadcast", { event: "chat" }, ({ payload }) => {
      const m = payload as ChatMsg;
      setChat((c) => [...c.slice(-100), m]);
    });

    channel.on("broadcast", { event: "guess" }, ({ payload }) => {
      const p = payload as { from: string; text: string };
      if (!isHostRef.current) return;
      hostHandleGuess(p.from, p.text);
    });

    channel.on("broadcast", { event: "word_choices" }, ({ payload }) => {
      const p = payload as { to: string; choices: string[] };
      if (p.to === playerId) setWordChoices(p.choices);
    });

    channel.on("broadcast", { event: "word_for_drawer" }, ({ payload }) => {
      const p = payload as { to: string; word: string };
      if (p.to === playerId) {
        setState((s) => ({ ...s, word: p.word }));
        setWordChoices(null);
      }
    });

    channel.on("broadcast", { event: "request_state" }, () => {
      if (isHostRef.current) broadcastState(stateRef.current);
    });

    channel.on("broadcast", { event: "pick_word" }, ({ payload }) => {
      if (!isHostRef.current) return;
      const p = payload as { word: string };
      hostStartDrawing(p.word);
    });

    channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel.track({ name: playerName, color: playerColor });
        channel.send({ type: "broadcast", event: "request_state", payload: {} });
      }
    });

    return () => {
      if (turnTimerRef.current) clearTimeout(turnTimerRef.current);
      supabase.removeChannel(channel);
    };
  }, [roomCode, playerId, playerName, playerColor, hostHandleGuess, broadcastState]);

  const sendGuess = () => {
    const text = guess.trim();
    if (!text) return;
    setGuess("");
    if (isHost) {
      hostHandleGuess(playerId, text);
    } else {
      broadcast("guess", { from: playerId, text });
    }
  };

  const handleStroke = (s: Stroke) => {
    broadcast("stroke", { from: playerId, stroke: s });
  };
  const handleClear = () => {
    broadcast("clear", {});
  };

  const startGame = () => {
    if (!isHost) return;
    startNextTurn();
  };

  const playAgain = () => {
    if (!isHost) return;
    const s = makeInitial();
    const ids = presenceIdsRef.current;
    for (const id of ids) {
      const prev = stateRef.current.players[id];
      s.players[id] = { id, name: prev?.name ?? "Player", color: prev?.color ?? "#888", score: 0, guessed: false };
    }
    s.turnOrder = ids;
    stateRef.current = s;
    setState(s);
    broadcastState(s);
    setTimeout(() => startNextTurn(), 100);
  };

  const isDrawer = state.drawerId === playerId;
  const drawer = state.drawerId ? state.players[state.drawerId] : null;
  const timeLeft = state.endsAt ? Math.max(0, Math.ceil((state.endsAt - now) / 1000)) : 0;
  const sortedPlayers = Object.values(state.players).sort((a, b) => b.score - a.score);

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50 p-3 md:p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <div className="bg-white rounded-lg px-3 py-2 shadow-sm border">
              <div className="text-xs text-muted-foreground">Room</div>
              <div className="font-mono font-bold tracking-wider">{roomCode}</div>
            </div>
            {state.phase !== "waiting" && state.phase !== "ended" && (
              <div className="bg-white rounded-lg px-3 py-2 shadow-sm border">
                <div className="text-xs text-muted-foreground">Round</div>
                <div className="font-bold">{state.round} / {state.totalRounds}</div>
              </div>
            )}
            {state.endsAt && state.phase !== "ended" && (
              <div className="bg-white rounded-lg px-3 py-2 shadow-sm border flex items-center gap-2">
                <Clock className="w-4 h-4 text-indigo-600" />
                <span className="font-bold tabular-nums">{timeLeft}s</span>
              </div>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={onLeave}>Leave</Button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr_300px] gap-4">
          <aside className="bg-white rounded-xl border shadow-sm p-3 order-2 lg:order-1">
            <div className="flex items-center gap-2 text-sm font-semibold mb-2 text-muted-foreground">
              <Users className="w-4 h-4" /> Players ({sortedPlayers.length})
            </div>
            <div className="space-y-1.5">
              {sortedPlayers.map((p, i) => (
                <div
                  key={p.id}
                  className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                    p.id === state.drawerId ? "bg-indigo-50 ring-1 ring-indigo-200" : ""
                  } ${p.guessed && p.id !== state.drawerId ? "bg-emerald-50" : ""}`}
                >
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-white font-bold text-xs shrink-0" style={{ backgroundColor: p.color }}>
                    {p.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium flex items-center gap-1">
                      {p.name}
                      {p.id === playerId && <span className="text-xs text-muted-foreground">(you)</span>}
                    </div>
                    <div className="text-xs text-muted-foreground">{p.score} pts</div>
                  </div>
                  {i === 0 && sortedPlayers.length > 1 && p.score > 0 && <Crown className="w-4 h-4 text-amber-500" />}
                  {p.id === state.drawerId && <Pencil className="w-4 h-4 text-indigo-600" />}
                </div>
              ))}
            </div>
          </aside>

          <main className="order-1 lg:order-2">
            <div className="bg-white rounded-xl border shadow-sm p-3 mb-3 text-center">
              {state.phase === "waiting" && (
                <div className="py-2">
                  <div className="font-bold text-lg">Waiting for players</div>
                  <div className="text-sm text-muted-foreground">
                    Share the room code <span className="font-mono font-bold">{roomCode}</span> with your friends.
                  </div>
                  {isHost && sortedPlayers.length >= 2 && (
                    <Button className="mt-3" onClick={startGame}>Start Game</Button>
                  )}
                  {isHost && sortedPlayers.length < 2 && (
                    <div className="text-xs text-muted-foreground mt-2">Need at least 2 players to start.</div>
                  )}
                  {!isHost && <div className="text-xs text-muted-foreground mt-2">Host will start the game.</div>}
                </div>
              )}
              {state.phase === "picking" && (
                <div className="py-2">
                  {isDrawer ? (
                    wordChoices ? (
                      <>
                        <div className="text-sm text-muted-foreground mb-2">Pick a word to draw</div>
                        <div className="flex flex-wrap gap-2 justify-center">
                          {wordChoices.map((w) => (
                            <Button key={w} onClick={() => {
                              if (isHost) hostStartDrawing(w);
                              else broadcast("pick_word", { word: w });
                            }}>{w}</Button>
                          ))}
                        </div>
                      </>
                    ) : (
                      <div className="text-sm">Loading word choices…</div>
                    )
                  ) : (
                    <div>
                      <div className="text-sm text-muted-foreground">Waiting for</div>
                      <div className="font-bold">{drawer?.name ?? "drawer"} to pick a word…</div>
                    </div>
                  )}
                </div>
              )}
              {state.phase === "drawing" && (
                <div className="py-1">
                  <div className="text-xs text-muted-foreground uppercase tracking-wide">
                    {isDrawer ? "Draw this" : `${drawer?.name ?? "Someone"} is drawing`}
                  </div>
                  <div className="font-mono font-bold text-xl tracking-widest">
                    {isDrawer ? state.word : state.maskedWord}
                  </div>
                  {!isDrawer && (
                    <div className="text-xs text-muted-foreground">{state.wordLength} letters</div>
                  )}
                </div>
              )}
              {state.phase === "intermission" && (
                <div className="py-2">
                  <div className="text-sm text-muted-foreground">The word was</div>
                  <div className="font-bold text-xl">{state.lastWord}</div>
                  <div className="text-xs text-muted-foreground mt-1">Next turn in {timeLeft}s…</div>
                </div>
              )}
              {state.phase === "ended" && (
                <div className="py-4">
                  <Trophy className="w-10 h-10 mx-auto text-amber-500 mb-2" />
                  <div className="font-bold text-xl">Game Over!</div>
                  {sortedPlayers[0] && (
                    <div className="text-sm mt-1">
                      Winner: <span className="font-bold">{sortedPlayers[0].name}</span> with {sortedPlayers[0].score} pts
                    </div>
                  )}
                  {isHost && <Button className="mt-3" onClick={playAgain}>Play Again</Button>}
                </div>
              )}
            </div>

            <DrawCanvas
              ref={canvasRef}
              drawable={state.phase === "drawing" && isDrawer}
              onStroke={handleStroke}
              onClear={handleClear}
            />
          </main>

          <aside className="bg-white rounded-xl border shadow-sm flex flex-col order-3 h-[400px] lg:h-auto lg:max-h-[80vh]">
            <div className="px-3 py-2 border-b text-sm font-semibold text-muted-foreground">Guesses & Chat</div>
            <ChatList chat={chat} />
            <form
              onSubmit={(e) => { e.preventDefault(); sendGuess(); }}
              className="border-t p-2 flex gap-2"
            >
              <Input
                value={guess}
                onChange={(e) => setGuess(e.target.value)}
                placeholder={isDrawer && state.phase === "drawing" ? "You can't guess your own drawing" : "Type your guess…"}
                disabled={isDrawer && state.phase === "drawing"}
                maxLength={60}
              />
              <Button type="submit" size="sm" disabled={isDrawer && state.phase === "drawing"}>Send</Button>
            </form>
          </aside>
        </div>

        <PickWordRelay
          isHost={isHost}
          channel={channelRef.current}
          onPicked={(word) => hostStartDrawing(word)}
        />
      </div>
    </div>
  );
}

function ChatList({ chat }: { chat: ChatMsg[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, [chat]);
  return (
    <div ref={ref} className="flex-1 overflow-y-auto p-2 space-y-1 text-sm">
      {chat.length === 0 && (
        <div className="text-xs text-muted-foreground text-center py-4">
          Guesses appear here. Get the word right to score!
        </div>
      )}
      {chat.map((m) => (
        <div
          key={m.id}
          className={
            m.kind === "correct"
              ? "px-2 py-1 rounded bg-emerald-100 text-emerald-900 font-medium"
              : m.kind === "system"
              ? "px-2 py-1 rounded bg-amber-50 text-amber-900 italic text-xs"
              : "px-2 py-1"
          }
        >
          {m.kind === "normal" && <span className="font-semibold mr-1">{m.from}:</span>}
          <span>{m.text}</span>
        </div>
      ))}
    </div>
  );
}

function PickWordRelay({ isHost, channel, onPicked }: {
  isHost: boolean;
  channel: RealtimeChannel | null;
  onPicked: (word: string) => void;
}) {
  useEffect(() => {
    if (!isHost || !channel) return;
    const sub = channel.on("broadcast", { event: "pick_word" }, ({ payload }) => {
      const p = payload as { word: string };
      onPicked(p.word);
    });
    return () => { void sub; };
  }, [isHost, channel, onPicked]);
  return null;
}
