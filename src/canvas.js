/**
 * Voice Vibes — Bot Canvas Renderer
 *
 * Draws the bot's vector drawings on a canvas with a progressive reveal:
 *  - line strokes (f:0) animate from start → end over their time window
 *  - fill shapes (f:1) "pop in" fully when their window arrives
 * Strokes are evenly scheduled across the drawing window.
 */

const LOGICAL_W = 1000;
const LOGICAL_H = 600;

export function createBotCanvas(hostEl) {
  const wrap = document.createElement("div");
  wrap.className = "canvas-wrap";
  wrap.innerHTML = `
    <div class="canvas-frame">
      <span class="bot-badge">🤖 Bot drawing…</span>
      <canvas class="draw-canvas"></canvas>
    </div>
  `;

  const canvas = wrap.querySelector("canvas");
  const ctx = canvas.getContext("2d");

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }

  function clear() {
    const rect = canvas.getBoundingClientRect();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, rect.width, rect.height);
  }

  function scalePts(pts) {
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width / LOGICAL_W;
    const sy = rect.height / LOGICAL_H;
    return pts.map(([x, y]) => [x * sx, y * sy]);
  }

  function drawStroke(stroke, frac) {
    const pts = scalePts(stroke.p);
    ctx.strokeStyle = stroke.c;
    ctx.fillStyle = stroke.c;
    ctx.lineWidth = stroke.s || 3;
    if (stroke.f) {
      // fill shapes pop in when fully revealed
      if (frac < 1) return;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.fill();
      if (stroke.s) ctx.stroke();
      return;
    }
    // line: draw the first `frac` of the polyline's length
    const partial = partialPolyline(pts, frac);
    if (partial.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(partial[0][0], partial[0][1]);
    for (let i = 1; i < partial.length; i++) ctx.lineTo(partial[i][0], partial[i][1]);
    ctx.stroke();
  }

  /**
   * Render the drawing at `elapsed` seconds into the drawing window.
   * stroke i starts at i*dt and takes dt to complete (dt = window/N, capped).
   */
  function render(strokes, elapsed, windowSec) {
    clear();
    if (!strokes || !strokes.length) return;
    const N = strokes.length;
    const dt = Math.max(0.7, Math.min(2.4, windowSec / N));
    for (let i = 0; i < N; i++) {
      const start = i * dt;
      const end = start + dt;
      let frac;
      if (elapsed >= end) frac = 1;
      else if (elapsed <= start) frac = 0;
      else frac = (elapsed - start) / dt;
      if (frac > 0) drawStroke(strokes[i], frac);
    }
  }

  hostEl.appendChild(wrap);
  requestAnimationFrame(resize);
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  return {
    el: wrap,
    render,
    clear,
    destroy() {
      ro.disconnect();
      wrap.remove();
    },
  };
}

function partialPolyline(pts, frac) {
  if (frac <= 0) return [pts[0]];
  if (frac >= 1) return pts;
  let total = 0;
  const lens = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const d = dist(pts[i], pts[i + 1]);
    lens.push(d);
    total += d;
  }
  if (total === 0) return pts;
  const target = total * frac;
  let acc = 0;
  const out = [pts[0]];
  for (let i = 0; i < lens.length; i++) {
    if (acc + lens[i] >= target) {
      const t = (target - acc) / lens[i];
      out.push([
        pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t,
        pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t,
      ]);
      break;
    }
    acc += lens[i];
    out.push(pts[i + 1]);
  }
  return out;
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
