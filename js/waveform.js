// Organic "alive" audio waveform.
//
// Earlier attempt used sin(freq*x + phase) components — but that is, by
// definition, a traveling wave: sin(f*x + speed*t) === sin(f*(x + (speed/f)*t)),
// which slides sideways at a constant rate. Drifting freq slowed that down
// but didn't remove it, and low-frequency/high-weight components still read
// as "sliding" since a small phase speed maps to a large effective x-shift
// when divided by a small frequency.
//
// This version has no spatial-frequency term anywhere, so it cannot slide
// even in principle: a handful of fixed x-anchor points across the width
// each independently random-walk their own height purely as a function of
// time (never of x), and the line drawn between them is a smooth spline
// interpolation recomputed every frame. Different anchors retarget on their
// own schedule, so different sections of the line visibly move
// independently — it can only morph in place, never translate.

let canvas, ctx, width, height;
let rafId = null;
let lastTime = null;
let currentEnergy = 0.16;
let targetEnergy = 0.16;
let pulseBoost = 0; // small transient nudge from a real TTS word-boundary event

function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function createAnchors(count) {
  const anchors = [];
  for (let i = 0; i <= count; i++) {
    anchors.push({
      value: Math.random() * 2 - 1,
      target: Math.random() * 2 - 1,
      retargetIn: Math.random() * 1.2,
    });
  }
  return anchors;
}

// Each anchor wanders toward a fresh random target on its own schedule — a
// cheap, dependency-free stand-in for per-point Perlin/Simplex noise.
function stepAnchors(anchors, dt, rate) {
  for (const a of anchors) {
    a.retargetIn -= dt;
    if (a.retargetIn <= 0) {
      a.target = Math.random() * 2 - 1;
      a.retargetIn = (0.5 + Math.random() * 1.1) / rate;
    }
    a.value += (a.target - a.value) * Math.min(1, dt * 3 * rate);
  }
}

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

function sampleAnchors(anchors, xNorm) {
  const segCount = anchors.length - 1;
  const pos = Math.min(xNorm, 1) * segCount;
  let i = Math.floor(pos);
  if (i >= segCount) i = segCount - 1;
  const t = pos - i;
  const p0 = anchors[Math.max(0, i - 1)].value;
  const p1 = anchors[i].value;
  const p2 = anchors[i + 1].value;
  const p3 = anchors[Math.min(anchors.length - 1, i + 2)].value;
  return catmullRom(p0, p1, p2, p3, t);
}

const blueAnchors = createAnchors(7);
const orangeAnchors = createAnchors(6);

function drawLine(anchors, { amplitude, color, lineWidth, yOffset }) {
  ctx.beginPath();
  const step = 4;
  for (let x = 0; x <= width; x += step) {
    const y = yOffset + sampleAnchors(anchors, x / width) * amplitude;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Neon glow: a soft blurred halo behind a crisp core, both the same
  // path (no re-tracing needed — stroke() just re-strokes the current path).
  ctx.shadowColor = color;
  ctx.shadowBlur = 18;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.stroke();
}

function renderFrame() {
  ctx.clearRect(0, 0, width, height);
  const midY = height / 2;
  const energyAmp = 6 + currentEnergy * 30; // gentle idle, energetic while listening/processing
  drawLine(blueAnchors, { amplitude: energyAmp, color: '#4d9de0', lineWidth: 5, yOffset: midY });
  drawLine(orangeAnchors, { amplitude: energyAmp * 0.45, color: '#f2a65a', lineWidth: 3, yOffset: midY + 30 });
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  width = canvas.clientWidth;
  height = canvas.clientHeight;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  renderFrame();
}

function tick(now) {
  const dt = lastTime ? Math.min(0.1, (now - lastTime) / 1000) : 0.016;
  lastTime = now;
  pulseBoost *= Math.pow(0.06, dt); // decays back to 0 quickly
  // Pulses ride through the exact same easing as ordinary state changes —
  // that's what keeps voice-reactivity here "seamless" rather than jumpy.
  const target = Math.min(1, targetEnergy + pulseBoost);
  currentEnergy += (target - currentEnergy) * Math.min(1, dt * 2);
  // Idle wanders slowly and calmly; energetic states retarget/evolve faster.
  const rate = 0.4 + currentEnergy * 1.6;
  stepAnchors(blueAnchors, dt, rate);
  stepAnchors(orangeAnchors, dt, rate);
  renderFrame();
  rafId = requestAnimationFrame(tick);
}

export function init(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
  if (reducedMotion()) {
    renderFrame();
  } else {
    rafId = requestAnimationFrame(tick);
  }
}

// 0 = idling gently, 1 = fully energetic (listening/processing). Eased
// frame-to-frame in tick(), so callers can just set a target and forget it.
export function setEnergy(level) {
  targetEnergy = Math.max(0, Math.min(1, level));
}

// A real word-boundary event arrived (see js/tts.js) — a small, subtle
// nudge, not a jump; it's eased through the same path as setEnergy() above.
export function pulseIn(amount = 0.12) {
  pulseBoost = Math.min(1, pulseBoost + amount);
}
