/**
 * docScanner.js
 * Real-time document detection, corner-marker overlay, perspective warp, and enhancement.
 *
 * Detection pipeline (runs at ~15 fps on a 160×120 thumbnail):
 *   grayscale → contrast-stretch → Sobel edges → extremal-projection corners
 *
 * Capture pipeline (runs once per scan):
 *   full-res grab → homography warp (DLT + bilinear) → auto-levels + contrast filter
 */

// ─── Tuning ───────────────────────────────────────────────────────────────────
const PROC_W  = 160;
const PROC_H  = 120;
const STABLE_FRAMES = 8;     // frames before auto-capture (less = faster response)
const STABLE_TOL    = 0.07;  // max corner drift (fraction of frame) — loose for handheld
const MIN_AREA_FRAC = 0.03;  // ignore detections covering < 3% of frame
const MIN_EDGES     = 30;    // min edge pixels required — very permissive
const EDGE_THRESH   = 0.12;  // Sobel magnitude threshold (fraction of max) — low
const MAX_WARP_DIM  = 1200;  // reduced from 1800 — still sharp enough for GPT-4o Vision, far less CPU
const MIN_OCR_DIM   = 900;   // reduced proportionally
// Run detection slower on mobile to spare the CPU (10fps vs 15fps on desktop)
const IS_MOBILE = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
const DETECT_MS = IS_MOBILE ? 100 : 66;

export class DocScanner {
  #video; #overlay; #ovCtx;
  #proc;  #procCtx;
  #detected        = null;   // normalized corners from last detection pass
  #smooth          = null;   // lerp'd corners used for drawing
  #stableN         = 0;
  #captured        = false;
  #onCapture       = null;
  #onTimeout       = null;
  #onDocChange     = null;
  #rafId           = null;
  #detectTid       = null;
  #timeoutTid      = null;
  #hasDoc          = false;
  #prevHasDoc      = false;

  constructor(videoEl, overlayCanvas) {
    this.#video   = videoEl;
    this.#overlay = overlayCanvas;
    this.#ovCtx   = overlayCanvas.getContext('2d');
    this.#proc    = document.createElement('canvas');
    this.#proc.width  = PROC_W;
    this.#proc.height = PROC_H;
    this.#procCtx = this.#proc.getContext('2d', { willReadFrequently: true });
  }

  get documentDetected() { return this.#hasDoc; }

  // ── Public API ──────────────────────────────────────────────────────────────

  start({ onCapture, onTimeout, onDocumentChange, timeoutMs = 15000 } = {}) {
    this.#onCapture  = onCapture;
    this.#onTimeout  = onTimeout;
    this.#onDocChange = onDocumentChange;
    this.#captured   = false;
    this.#detected   = null;
    this.#smooth     = null;
    this.#stableN    = 0;
    this.#hasDoc     = false;
    this.#scheduleDetect();
    this.#animLoop();
    this.#timeoutTid = setTimeout(() => {
      if (!this.#captured) { this.stop(); this.#onTimeout?.(); }
    }, timeoutMs);
  }

  stop() {
    clearTimeout(this.#detectTid);
    clearTimeout(this.#timeoutTid);
    cancelAnimationFrame(this.#rafId);
    this.#detectTid  = null;
    this.#timeoutTid = null;
    this.#rafId      = null;
    this.#ovCtx.clearRect(0, 0, this.#overlay.width || 1, this.#overlay.height || 1);
  }

  /** Manually trigger capture (e.g. user taps shutter button) */
  capture() {
    if (!this.#captured) this.#doCapture();
  }

  // ── Detection loop ──────────────────────────────────────────────────────────

  #scheduleDetect() {
    this.#detectTid = setTimeout(() => {
      this.#runDetect();
      if (this.#detectTid !== null) this.#scheduleDetect();
    }, DETECT_MS);
  }

  #runDetect() {
    const vw = this.#video.videoWidth, vh = this.#video.videoHeight;
    if (!vw || !vh) return;

    // Keep overlay canvas matched to video resolution
    if (this.#overlay.width !== vw || this.#overlay.height !== vh) {
      this.#overlay.width = vw; this.#overlay.height = vh;
    }

    this.#procCtx.drawImage(this.#video, 0, 0, PROC_W, PROC_H);
    const { data } = this.#procCtx.getImageData(0, 0, PROC_W, PROC_H);
    const corners = this.#findQuad(data, PROC_W, PROC_H);

    if (corners) {
      this.#hasDoc = true;
      if (this.#detected && this.#cornersClose(this.#detected, corners)) {
        this.#stableN++;
      } else {
        this.#stableN = 0;
      }
      this.#detected = corners;
      if (this.#stableN >= STABLE_FRAMES && !this.#captured) this.#doCapture();
    } else {
      this.#hasDoc  = false;
      this.#stableN = 0;
      this.#detected = null;
    }
    if (this.#hasDoc !== this.#prevHasDoc) {
      this.#prevHasDoc = this.#hasDoc;
      this.#onDocChange?.(this.#hasDoc);
    }
  }

  // ── Corner finding ──────────────────────────────────────────────────────────

  #findQuad(data, w, h) {
    // 1. Grayscale
    const gray = new Float32Array(w * h);
    let lo = 255, hi = 0;
    for (let i = 0; i < w * h; i++) {
      const g = 0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2];
      gray[i] = g;
      if (g < lo) lo = g;
      if (g > hi) hi = g;
    }
    const span = hi - lo || 1;
    const n = v => (gray[v] - lo) / span;

    // 2. Sobel magnitude
    const mag = new Float32Array(w * h);
    let maxMag = 0;
    for (let y = 1; y < h-1; y++) {
      for (let x = 1; x < w-1; x++) {
        const i = y*w+x;
        const gx = -n(i-w-1) - 2*n(i-1) - n(i+w-1) + n(i-w+1) + 2*n(i+1) + n(i+w+1);
        const gy = -n(i-w-1) - 2*n(i-w) - n(i-w+1) + n(i+w-1) + 2*n(i+w) + n(i+w+1);
        mag[i] = Math.sqrt(gx*gx + gy*gy);
        if (mag[i] > maxMag) maxMag = mag[i];
      }
    }

    // 3. Extremal corners from edge pixels above threshold
    const thr = maxMag * EDGE_THRESH;
    const pad = 5;
    let tlS = Infinity, trS = -Infinity, brS = -Infinity, blS = Infinity;
    let tl, tr, br, bl, count = 0;

    for (let y = pad; y < h-pad; y++) {
      for (let x = pad; x < w-pad; x++) {
        if (mag[y*w+x] < thr) continue;
        count++;
        const s1 = x+y, s2 = x-y;
        if (s1 < tlS) { tlS = s1; tl = {x,y}; }
        if (s1 > brS) { brS = s1; br = {x,y}; }
        if (s2 > trS) { trS = s2; tr = {x,y}; }
        if (s2 < blS) { blS = s2; bl = {x,y}; }
      }
    }

    if (count < MIN_EDGES || !tl || !tr || !br || !bl) return null;

    // 4. Validate area and minimum corner spread
    if (quadArea(tl, tr, br, bl) < w*h*MIN_AREA_FRAC) return null;
    const pts = [tl, tr, br, bl];
    for (let i = 0; i < 4; i++) {
      for (let j = i+1; j < 4; j++) {
        if (Math.hypot(pts[i].x-pts[j].x, pts[i].y-pts[j].y) < Math.min(w,h)*0.05) return null;
      }
    }

    return [
      {x: tl.x/w, y: tl.y/h},
      {x: tr.x/w, y: tr.y/h},
      {x: br.x/w, y: br.y/h},
      {x: bl.x/w, y: bl.y/h},
    ];
  }

  #cornersClose(a, b) {
    for (let i = 0; i < 4; i++) {
      if (Math.abs(a[i].x-b[i].x) > STABLE_TOL || Math.abs(a[i].y-b[i].y) > STABLE_TOL) return false;
    }
    return true;
  }

  // Map normalized video coords to canvas coords, accounting for object-fit:cover
  #toCanvas(normPt, cw, ch) {
    const vw = this.#video.videoWidth, vh = this.#video.videoHeight;
    if (!vw || !vh) return { x: normPt.x * cw, y: normPt.y * ch };
    const scale = Math.max(cw / vw, ch / vh);
    const offX  = (vw * scale - cw) / 2;
    const offY  = (vh * scale - ch) / 2;
    return { x: normPt.x * vw * scale - offX, y: normPt.y * vh * scale - offY };
  }

  // ── Overlay drawing ─────────────────────────────────────────────────────────

  #animLoop() {
    this.#draw();
    this.#rafId = requestAnimationFrame(() => this.#animLoop());
  }

  #draw() {
    const ow = this.#overlay.width  || window.innerWidth;
    const oh = this.#overlay.height || window.innerHeight;
    const ctx = this.#ovCtx;
    ctx.clearRect(0, 0, ow, oh);

    if (!this.#detected) {
      this.#smooth = null;
      drawGuide(ctx, ow, oh);          // faint guide frame
      return;
    }

    // Lerp smooth corners
    if (!this.#smooth) {
      this.#smooth = this.#detected.map(c => ({...c}));
    } else {
      const a = 0.2;
      for (let i = 0; i < 4; i++) {
        this.#smooth[i].x += a * (this.#detected[i].x - this.#smooth[i].x);
        this.#smooth[i].y += a * (this.#detected[i].y - this.#smooth[i].y);
      }
    }

    const pts = this.#smooth.map(c => this.#toCanvas(c, ow, oh));
    const stable  = this.#stableN > 8;
    const color   = stable ? '#4ade80' : '#e8a13a';
    const progress = stable
      ? Math.min(1, (this.#stableN - 8) / (STABLE_FRAMES - 8))
      : 0;

    // Filled polygon
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = stable ? 'rgba(74,222,128,0.09)' : 'rgba(232,161,58,0.09)';
    ctx.fill();

    // Outline
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.strokeStyle = color + 'bb';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Corner L-brackets
    const len = Math.min(ow, oh) * 0.08;
    ctx.strokeStyle = color;
    ctx.lineWidth   = 3.5;
    ctx.lineCap     = 'round';
    for (let i = 0; i < 4; i++) {
      const c    = pts[i];
      const d1   = unitVec({x: pts[(i+3)%4].x-c.x, y: pts[(i+3)%4].y-c.y});
      const d2   = unitVec({x: pts[(i+1)%4].x-c.x, y: pts[(i+1)%4].y-c.y});
      ctx.beginPath();
      ctx.moveTo(c.x + d1.x*len, c.y + d1.y*len);
      ctx.lineTo(c.x, c.y);
      ctx.lineTo(c.x + d2.x*len, c.y + d2.y*len);
      ctx.stroke();
    }

    // Progress ring when stable
    if (progress > 0) {
      const cx = ow/2, cy = oh/2, r = Math.min(ow,oh)*0.055;
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI/2, -Math.PI/2 + 2*Math.PI*progress);
      ctx.strokeStyle = color;
      ctx.lineWidth   = 3;
      ctx.stroke();
    }
  }

  // ── Capture + processing ────────────────────────────────────────────────────

  async #doCapture() {
    this.#captured = true;
    this.stop();

    const vw = this.#video.videoWidth, vh = this.#video.videoHeight;
    const raw = document.createElement('canvas');
    raw.width = vw; raw.height = vh;
    raw.getContext('2d').drawImage(this.#video, 0, 0);

    let processed = raw;
    if (this.#detected) {
      try { processed = await perspectiveWarp(raw, this.#detected); } catch {}
    }
    processed = enhance(processed);

    this.#onCapture?.(processed);
  }
}

// ─── Guide overlay (no document detected) ────────────────────────────────────

function drawGuide(ctx, w, h) {
  const mx = w*0.07, my = h*0.10;
  const gw = w - mx*2, gh = h - my*2;
  const len = Math.min(w,h)*0.09;
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  const corners = [[mx,my,1,1],[mx+gw,my,-1,1],[mx+gw,my+gh,-1,-1],[mx,my+gh,1,-1]];
  for (const [cx,cy,sx,sy] of corners) {
    ctx.beginPath();
    ctx.moveTo(cx + sx*len, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + sy*len);
    ctx.stroke();
  }
}

// ─── Perspective warp (homography) ───────────────────────────────────────────

async function perspectiveWarp(src, normCorners) {
  const sw = src.width, sh = src.height;
  const [tl,tr,br,bl] = normCorners.map(c => ({x:c.x*sw, y:c.y*sh}));

  let outW = Math.round(Math.max(Math.hypot(tr.x-tl.x,tr.y-tl.y), Math.hypot(br.x-bl.x,br.y-bl.y)));
  let outH = Math.round(Math.max(Math.hypot(bl.x-tl.x,bl.y-tl.y), Math.hypot(br.x-tr.x,br.y-tr.y)));

  // Cap output size for performance
  const scale = Math.min(1, MAX_WARP_DIM / Math.max(outW, outH));
  outW = Math.round(outW*scale); outH = Math.round(outH*scale);

  const H = computeH(
    [{x:0,y:0},{x:outW,y:0},{x:outW,y:outH},{x:0,y:outH}],
    [tl,tr,br,bl]
  );
  if (!H) return src;

  const srcData = src.getContext('2d').getImageData(0,0,sw,sh).data;
  const dst     = document.createElement('canvas');
  dst.width = outW; dst.height = outH;
  const dstCtx  = dst.getContext('2d');
  const dstImg  = dstCtx.createImageData(outW, outH);
  const dstData = dstImg.data;

  for (let dy = 0; dy < outH; dy++) {
    for (let dx = 0; dx < outW; dx++) {
      const {x:sx, y:sy} = applyH(H, dx, dy);
      const fx = sx - Math.floor(sx), fy = sy - Math.floor(sy);
      const ix = Math.floor(sx),      iy = Math.floor(sy);
      if (ix < 0 || ix >= sw-1 || iy < 0 || iy >= sh-1) continue;
      const i00=(iy*sw+ix)*4, i10=i00+4, i01=i00+sw*4, i11=i01+4;
      const di = (dy*outW+dx)*4;
      for (let c = 0; c < 3; c++) {
        dstData[di+c] = Math.round(
          srcData[i00+c]*(1-fx)*(1-fy) + srcData[i10+c]*fx*(1-fy) +
          srcData[i01+c]*(1-fx)*fy     + srcData[i11+c]*fx*fy
        );
      }
      dstData[di+3] = 255;
    }
  }

  dstCtx.putImageData(dstImg, 0, 0);
  return dst;
}

function computeH(srcPts, dstPts) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const {x,y} = srcPts[i], {x:X,y:Y} = dstPts[i];
    A.push([x,y,1,0,0,0,-X*x,-X*y,X]);
    A.push([0,0,0,x,y,1,-Y*x,-Y*y,Y]);
  }
  const h = solveLinear(A);
  if (!h) return null;
  return [[h[0],h[1],h[2]],[h[3],h[4],h[5]],[h[6],h[7],1]];
}

function applyH(H, x, y) {
  const w = H[2][0]*x + H[2][1]*y + H[2][2];
  return { x:(H[0][0]*x+H[0][1]*y+H[0][2])/w, y:(H[1][0]*x+H[1][1]*y+H[1][2])/w };
}

function solveLinear(A) {
  const n = 8;
  const M = A.map(r => [...r]);
  for (let col = 0; col < n; col++) {
    let mx = col;
    for (let r = col+1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[mx][col])) mx = r;
    [M[col], M[mx]] = [M[mx], M[col]];
    if (Math.abs(M[col][col]) < 1e-10) return null;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col]/M[col][col];
      for (let k = col; k <= n; k++) M[r][k] -= f*M[col][k];
    }
  }
  return M.map((row,i) => row[n]/row[i]);
}

// ─── Image enhancement ────────────────────────────────────────────────────────

function enhance(canvas) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d   = img.data;

  // Per-channel auto-levels
  const mins = [255,255,255], maxs = [0,0,0];
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      if (d[i+c] < mins[c]) mins[c] = d[i+c];
      if (d[i+c] > maxs[c]) maxs[c] = d[i+c];
    }
  }
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const span = (maxs[c]-mins[c]) || 1;
      d[i+c] = Math.min(255, Math.round(((d[i+c]-mins[c])/span)*255*1.08));
    }
  }
  ctx.putImageData(img, 0, 0);

  // Upscale to MIN_OCR_DIM if image is small — Tesseract accuracy improves with resolution
  const long   = Math.max(w, h);
  const upscale = long < MIN_OCR_DIM ? MIN_OCR_DIM / long : 1;
  const outW   = Math.round(w * upscale);
  const outH   = Math.round(h * upscale);

  // Final contrast + brightness boost via CSS filter (GPU path)
  const out  = document.createElement('canvas');
  out.width  = outW; out.height = outH;
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.filter = 'contrast(1.18) brightness(1.06)';
  octx.drawImage(canvas, 0, 0, outW, outH);
  octx.filter = 'none';
  return out;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function unitVec(v) {
  const len = Math.sqrt(v.x*v.x + v.y*v.y) || 1;
  return {x:v.x/len, y:v.y/len};
}

function quadArea(tl, tr, br, bl) {
  const pts = [tl,tr,br,bl];
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i+1)%4;
    a += pts[i].x*pts[j].y - pts[j].x*pts[i].y;
  }
  return Math.abs(a)/2;
}
