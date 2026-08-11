/**
 * Voice Vibes — drawing canvas (ported from the original React DrawCanvas).
 *
 * Logical coordinate system: 1000x600, scaled to the actual canvas size so
 * strokes are resolution-independent across devices. Strokes are broadcast
 * as {from, to, color, size} segments and replayed remotely.
 */

const COLORS = ["#000000", "#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#ffffff"];

const LOGICAL_W = 1000;
const LOGICAL_H = 600;

export function createCanvas(hostEl, { drawable, onStroke, onClear }) {
  const wrap = document.createElement("div");
  wrap.className = "canvas-wrap";
  wrap.innerHTML = `
    <div class="canvas-frame">
      <canvas class="draw-canvas"></canvas>
    </div>
    <div class="canvas-tools"></div>
  `;

  const canvas = wrap.querySelector("canvas");
  const toolsEl = wrap.querySelector(".canvas-tools");
  const ctx = canvas.getContext("2d");

  let drawing = false;
  let last = null;
  let color = "#000000";
  let size = 4;
  let erasing = false;

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

  function drawLine(s) {
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width / LOGICAL_W;
    const sy = rect.height / LOGICAL_H;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.size * Math.min(sx, sy);
    ctx.beginPath();
    ctx.moveTo(s.from.x * sx, s.from.y * sy);
    ctx.lineTo(s.to.x * sx, s.to.y * sy);
    ctx.stroke();
  }

  function clearCanvas() {
    const rect = canvas.getBoundingClientRect();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, rect.width, rect.height);
  }

  function toLogical(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * LOGICAL_W,
      y: ((e.clientY - rect.top) / rect.height) * LOGICAL_H,
    };
  }

  function handleDown(e) {
    if (!drawable()) return;
    e.preventDefault();
    drawing = true;
    last = toLogical(e);
    canvas.setPointerCapture(e.pointerId);
  }
  function handleMove(e) {
    if (!drawable() || !drawing || !last) return;
    const to = toLogical(e);
    const stroke = {
      from: last,
      to,
      color: erasing ? "#ffffff" : color,
      size: erasing ? 24 : size,
    };
    drawLine(stroke);
    onStroke(stroke);
    last = to;
  }
  function handleUp() {
    drawing = false;
    last = null;
  }

  canvas.addEventListener("pointerdown", handleDown);
  canvas.addEventListener("pointermove", handleMove);
  canvas.addEventListener("pointerup", handleUp);
  canvas.addEventListener("pointerleave", handleUp);

  // Toolbar (only when drawable)
  function renderTools() {
    toolsEl.innerHTML = "";
    if (!drawable()) return;
    const colorsRow = document.createElement("div");
    colorsRow.className = "tool-row";
    COLORS.forEach((c) => {
      const b = document.createElement("button");
      b.className = "swatch" + (color === c && !erasing ? " active" : "");
      b.style.backgroundColor = c;
      b.title = c;
      b.addEventListener("click", () => {
        color = c;
        erasing = false;
        renderTools();
      });
      colorsRow.appendChild(b);
    });
    const sizesRow = document.createElement("div");
    sizesRow.className = "tool-row sizes-row";
    [2, 4, 8, 16].forEach((s) => {
      const b = document.createElement("button");
      b.className = "size-dot" + (size === s ? " active" : "");
      b.style.width = s + 8 + "px";
      b.style.height = s + 8 + "px";
      b.addEventListener("click", () => {
        size = s;
        renderTools();
      });
      sizesRow.appendChild(b);
    });
    const eraserBtn = document.createElement("button");
    eraserBtn.className = "tool-btn" + (erasing ? " active" : "");
    eraserBtn.textContent = "🧽 Eraser";
    eraserBtn.addEventListener("click", () => {
      erasing = !erasing;
      renderTools();
    });
    const clearBtn = document.createElement("button");
    clearBtn.className = "tool-btn";
    clearBtn.textContent = "🗑️ Clear";
    clearBtn.addEventListener("click", () => {
      clearCanvas();
      onClear();
    });
    toolsEl.appendChild(colorsRow);
    toolsEl.appendChild(sizesRow);
    const row2 = document.createElement("div");
    row2.className = "tool-row";
    row2.appendChild(eraserBtn);
    row2.appendChild(clearBtn);
    toolsEl.appendChild(row2);
  }

  function refreshDrawable() {
    canvas.style.cursor = drawable() ? "crosshair" : "default";
    renderTools();
  }

  // Initial draw + observer for drawable changes
  requestAnimationFrame(() => {
    resize();
    refreshDrawable();
  });

  const ro = new ResizeObserver(() => {
    // Preserve content across resize by re-rendering from stored strokes is
    // complex; simplest: keep drawing area stable (we don't rescale mid-turn).
    // Only resize the backing store when the element actually changes size.
    resize();
  });
  ro.observe(canvas);

  // Re-render toolbar whenever drawable flips (called by the game loop)
  let lastDrawable = drawable();
  const stateCheck = setInterval(() => {
    const cur = drawable();
    if (cur !== lastDrawable) {
      lastDrawable = cur;
      refreshDrawable();
    }
  }, 500);

  hostEl.appendChild(wrap);

  return {
    el: wrap,
    drawRemoteStroke: drawLine,
    clearRemote: clearCanvas,
    destroy() {
      clearInterval(stateCheck);
      ro.disconnect();
      wrap.remove();
    },
    refresh: refreshDrawable,
  };
}
