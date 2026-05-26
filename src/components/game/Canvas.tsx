import { useEffect, useRef, useImperativeHandle, forwardRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Eraser, Trash2 } from "lucide-react";

export type Stroke = {
  from: { x: number; y: number };
  to: { x: number; y: number };
  color: string;
  size: number;
};

export type CanvasHandle = {
  drawRemoteStroke: (s: Stroke) => void;
  clearRemote: () => void;
};

type Props = {
  drawable: boolean;
  onStroke: (s: Stroke) => void;
  onClear: () => void;
};

const COLORS = ["#000000", "#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#ffffff"];

export const DrawCanvas = forwardRef<CanvasHandle, Props>(function DrawCanvas(
  { drawable, onStroke, onClear },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [color, setColor] = useState("#000000");
  const [size, setSize] = useState(4);
  const [erasing, setErasing] = useState(false);

  // Internal logical coordinate system: 1000x600. We scale strokes to canvas size.
  const LOGICAL_W = 1000;
  const LOGICAL_H = 600;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      const ctx = canvas.getContext("2d");
      ctx?.scale(dpr, dpr);
      if (ctx) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, rect.width, rect.height);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
      }
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const drawLine = (s: Stroke) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width / LOGICAL_W;
    const sy = rect.height / LOGICAL_H;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.size * Math.min(sx, sy);
    ctx.beginPath();
    ctx.moveTo(s.from.x * sx, s.from.y * sy);
    ctx.lineTo(s.to.x * sx, s.to.y * sy);
    ctx.stroke();
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, rect.width, rect.height);
  };

  useImperativeHandle(ref, () => ({
    drawRemoteStroke: drawLine,
    clearRemote: clearCanvas,
  }));

  const toLogical = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * LOGICAL_W,
      y: ((e.clientY - rect.top) / rect.height) * LOGICAL_H,
    };
  };

  const handleDown = (e: React.PointerEvent) => {
    if (!drawable) return;
    drawing.current = true;
    last.current = toLogical(e);
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const handleMove = (e: React.PointerEvent) => {
    if (!drawable || !drawing.current || !last.current) return;
    const to = toLogical(e);
    const stroke: Stroke = {
      from: last.current,
      to,
      color: erasing ? "#ffffff" : color,
      size: erasing ? 24 : size,
    };
    drawLine(stroke);
    onStroke(stroke);
    last.current = to;
  };
  const handleUp = () => {
    drawing.current = false;
    last.current = null;
  };

  return (
    <div className="flex flex-col gap-2 w-full">
      <div className="relative w-full aspect-[5/3] rounded-lg overflow-hidden border-2 border-border bg-white shadow-sm">
        <canvas
          ref={canvasRef}
          onPointerDown={handleDown}
          onPointerMove={handleMove}
          onPointerUp={handleUp}
          onPointerLeave={handleUp}
          className="w-full h-full touch-none"
          style={{ cursor: drawable ? "crosshair" : "default" }}
        />
      </div>
      {drawable && (
        <div className="flex flex-wrap items-center gap-2">
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => { setColor(c); setErasing(false); }}
              className="w-7 h-7 rounded-full border-2 transition"
              style={{
                backgroundColor: c,
                borderColor: color === c && !erasing ? "#111" : "rgba(0,0,0,0.1)",
                transform: color === c && !erasing ? "scale(1.15)" : "scale(1)",
              }}
              aria-label={`color ${c}`}
            />
          ))}
          <div className="flex items-center gap-1 ml-2">
            {[2, 4, 8, 16].map((s) => (
              <button
                key={s}
                onClick={() => setSize(s)}
                className="rounded-full bg-foreground/80 transition"
                style={{
                  width: s + 8,
                  height: s + 8,
                  opacity: size === s ? 1 : 0.4,
                }}
                aria-label={`size ${s}`}
              />
            ))}
          </div>
          <Button
            size="sm"
            variant={erasing ? "default" : "outline"}
            onClick={() => setErasing((e) => !e)}
          >
            <Eraser className="w-4 h-4" />
          </Button>
          <Button size="sm" variant="outline" onClick={() => { clearCanvas(); onClear(); }}>
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      )}
    </div>
  );
});
