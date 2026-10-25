// Drawing board: strokes are stored as normalised points (0..1) so every screen size agrees.
// A stroke is { id, tool: 'brush'|'eraser'|'fill', color, size, points: [[x, y, widthFactor], ...] }
const hexToRgb = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

export class Board {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.W = canvas.width; this.H = canvas.height;
    this.strokes = [];
    this.wipe();
  }

  wipe() { this.ctx.fillStyle = '#ffffff'; this.ctx.fillRect(0, 0, this.W, this.H); }

  redraw() { this.wipe(); for (const s of this.strokes) this.paint(s); }

  paint(s) {
    if (s.tool === 'fill') { this.floodFill(Math.round(s.points[0][0] * (this.W - 1)), Math.round(s.points[0][1] * (this.H - 1)), s.color); return; }
    for (let i = 0; i < s.points.length; i++) this.segment(s, i);
  }

  segment(s, i) {
    const { ctx, W, H } = this;
    const p = s.points[i], prev = s.points[i - 1];
    const col = s.tool === 'eraser' ? '#ffffff' : s.color;
    const width = Math.max(1, s.size * (p[2] || 1));
    ctx.fillStyle = col; ctx.strokeStyle = col; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (!prev) { ctx.beginPath(); ctx.arc(p[0] * W, p[1] * H, width / 2, 0, Math.PI * 2); ctx.fill(); return; }
    ctx.beginPath(); ctx.moveTo(prev[0] * W, prev[1] * H); ctx.lineTo(p[0] * W, p[1] * H); ctx.stroke();
  }

  addStroke(s) { this.strokes.push(s); this.paint(s); }

  appendPoints(id, pts) {
    let s = null;
    for (let i = this.strokes.length - 1; i >= 0; i--) if (this.strokes[i].id === id) { s = this.strokes[i]; break; }
    if (!s) return;
    for (const p of pts) { s.points.push(p); this.segment(s, s.points.length - 1); }
  }

  undo() { this.strokes.pop(); this.redraw(); }
  clearAll() { this.strokes = []; this.wipe(); }
  setStrokes(list) { this.strokes = (list || []).map(s => ({ ...s, points: s.points.map(p => p.slice()) })); this.redraw(); }

  // Scanline flood fill with a small tolerance so anti-aliased edges are covered too.
  floodFill(sx, sy, hex) {
    const { ctx, W, H } = this;
    if (sx < 0 || sy < 0 || sx >= W || sy >= H) return;
    const img = ctx.getImageData(0, 0, W, H), d = img.data;
    const [fr, fg, fb] = hexToRgb(hex);
    const i0 = (sy * W + sx) * 4, tr = d[i0], tg = d[i0 + 1], tb = d[i0 + 2];
    if (tr === fr && tg === fg && tb === fb) return;
    const TOL = 48, seen = new Uint8Array(W * H);
    const ok = (q) => { const i = q * 4; return !seen[q] && Math.abs(d[i] - tr) + Math.abs(d[i + 1] - tg) + Math.abs(d[i + 2] - tb) <= TOL; };
    const stack = [sx, sy];
    while (stack.length) {
      const y = stack.pop(), x = stack.pop();
      if (!ok(y * W + x)) continue;
      let l = x, r = x;
      while (l > 0 && ok(y * W + l - 1)) l--;
      while (r < W - 1 && ok(y * W + r + 1)) r++;
      for (let k = l; k <= r; k++) {
        const q = y * W + k, i = q * 4;
        seen[q] = 1; d[i] = fr; d[i + 1] = fg; d[i + 2] = fb; d[i + 3] = 255;
      }
      for (const ny of [y - 1, y + 1]) {
        if (ny < 0 || ny >= H) continue;
        let run = false;
        for (let k = l; k <= r; k++) {
          const good = ok(ny * W + k);
          if (good && !run) { stack.push(k, ny); run = true; } else if (!good) run = false;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }
}
