// Ambient edge glow — a best-effort recreation of Gemini Live's edge-glow
// visual identity: a soft, multi-color, blurred glow that hugs the screen
// edges behind the UI, breathing gently at idle and growing more alive
// while listening/speaking.
//
// Honesty notes on what's real vs. simulated, since this matters for an
// "audio-reactive" effect:
//   - LISTENING is driven by genuine microphone frequency data (via
//     js/micAnalyser.js + a real Web Audio AnalyserNode) — actual bass/mid/
//     treble levels, not invented numbers.
//   - SPEAKING is driven by real utterance start/end timing and (where the
//     browser supports it) real per-word `boundary` events from
//     js/tts.js — but speechSynthesis exposes no amplitude data at all, so
//     the *magnitude* of each speaking pulse is synthetic, only its timing
//     is real.
//   - IDLE and THINKING have no audio source at all by design (nothing to
//     react to), so they run on procedural noise alone — intentionally
//     "never stops moving" rather than ever looking static.
//
// Rendering approach: layered radial-gradient blobs on a single full-
// viewport <canvas>, composited with `lighter` (additive) blending for the
// bloom/light-diffusion look, plus a CSS blur filter on the canvas element
// itself (GPU-composited, cheap) for the final soft diffusion. This is
// deliberately Canvas2D rather than hand-written WebGL shaders — it hits
// the "GPU-accelerated, 60fps, no heavy libraries" requirements without the
// much larger risk surface of shader code none of this project's other
// modules use.

import * as mic from './micAnalyser.js';

// ---------------------------------------------------------------------------
// Configuration — tweak freely.
// ---------------------------------------------------------------------------
export const config = {
  colors: {
    blue: '#2E5FEA',
    red: '#EA4B45',
  },
  intensity: 1, // global brightness/opacity multiplier
  speed: 1, // global animation-speed multiplier
  blurPx: 80, // canvas CSS blur radius — the main "diffusion" knob
};

const STATE_PRESETS = {
  // base: resting energy level (0..1) with nothing else going on.
  // rate: how fast the procedural noise drifts (idle = slow/calm).
  idle: { base: 0.2, rate: 0.4 },
  thinking: { base: 0.32, rate: 0.75 },
  listening: { base: 0.34, rate: 0.85 },
  speaking: { base: 0.5, rate: 1.1 },
};

let canvas, ctx, width, height;
let rafId = null;
let lastTime = null;

let state = 'idle';
let preset = STATE_PRESETS.idle;

// Smoothed (attack/release) energy levels. `energy` is the overall driver;
// bass/mid/treble are only meaningful while genuinely listening.
let energy = 0;
let bandLevels = { bass: 0, mid: 0, treble: 0 };
let prevMicOverall = 0;
let speakingPulse = 0; // transient boost from a real TTS word-boundary event

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgba(hex, a) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// One-pole exponential envelope follower — fast attack, slower release, so
// transients register immediately but decay naturally instead of jittering.
function follow(current, target, dt, attackTau, releaseTau) {
  const tau = target > current ? attackTau : releaseTau;
  const alpha = 1 - Math.exp(-dt / Math.max(0.001, tau));
  return current + (target - current) * alpha;
}

// ---------------------------------------------------------------------------
// Procedural noise-walk (the same dependency-free technique used by
// js/waveform.js): wander toward a fresh random target on a schedule,
// instead of a fixed-frequency sine, so motion never reads as a clean loop.
// ---------------------------------------------------------------------------
function createNoise() {
  return { value: Math.random() * 2 - 1, target: Math.random() * 2 - 1, retargetIn: Math.random() * 1.2 };
}

function stepNoise(n, dt, rate) {
  n.retargetIn -= dt * rate;
  if (n.retargetIn <= 0) {
    n.target = Math.random() * 2 - 1;
    n.retargetIn = 0.6 + Math.random() * 1.4;
  }
  n.value += (n.target - n.value) * Math.min(1, dt * rate * 1.8);
}

// ---------------------------------------------------------------------------
// Blobs: soft colored lights anchored around the edges/corners. Each has
// its own independent drift/breathing noise so different regions of the
// glow move on their own schedule — never a single shape sliding uniformly.
// ---------------------------------------------------------------------------
function makeBlob(xFrac, yFrac, baseRadiusFrac, color, weight) {
  return {
    xFrac, yFrac, baseRadiusFrac, color, weight,
    driftX: createNoise(),
    driftY: createNoise(),
    breathe: createNoise(),
    flicker: createNoise(),
  };
}

// Just two large blobs anchored at the bottom corners, matching the
// reference exactly: solid black elsewhere, blue bottom-left, red/coral
// bottom-right. Where the two overlap near bottom-center, additive
// blending naturally produces a magenta/purple blend zone — no separate
// third blob is needed for that.
const blobs = [
  makeBlob(0.0, 1.12, 0.78, config.colors.blue, 1.0), // bottom-left, anchored a little below the edge
  makeBlob(1.0, 1.12, 0.78, config.colors.red, 1.0), // bottom-right, anchored a little below the edge
];

function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  width = canvas.clientWidth;
  height = canvas.clientHeight;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function renderFrame() {
  ctx.clearRect(0, 0, width, height);
  const minSide = Math.min(width, height);
  const calm = reducedMotion();

  ctx.globalCompositeOperation = 'lighter'; // additive blending = bloom-style light mixing

  for (const blob of blobs) {
    const localEnergy = energy;

    const breathe = calm ? 0 : blob.breathe.value * 0.12;
    const driftX = calm ? 0 : blob.driftX.value * minSide * 0.05;
    const driftY = calm ? 0 : blob.driftY.value * minSide * 0.05;
    const flicker = calm ? 1 : 1 + blob.flicker.value * 0.15;

    const radius = blob.baseRadiusFrac * minSide * (0.78 + localEnergy * 0.45 + breathe);
    const cx = blob.xFrac * width + driftX;
    const cy = blob.yFrac * height + driftY;

    const peakAlpha = clamp01(blob.weight * localEnergy * config.intensity * flicker * 0.9);
    if (peakAlpha <= 0.002 || radius <= 0) continue;

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    grad.addColorStop(0, rgba(blob.color, peakAlpha));
    grad.addColorStop(0.55, rgba(blob.color, peakAlpha * 0.45));
    grad.addColorStop(1, rgba(blob.color, 0));

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalCompositeOperation = 'source-over';
}

function tick(now) {
  const dt = lastTime ? Math.min(0.1, (now - lastTime) / 1000) : 0.016;
  lastTime = now;
  const speed = config.speed * preset.rate;

  if (!reducedMotion()) {
    for (const blob of blobs) {
      stepNoise(blob.driftX, dt, speed);
      stepNoise(blob.driftY, dt, speed);
      stepNoise(blob.breathe, dt, speed * 1.3);
      stepNoise(blob.flicker, dt, speed * 2.2);
    }
  }

  // Real microphone bands while listening; decays naturally if mic is
  // unavailable/denied (target just falls back to the state's base level).
  let micTarget = 0;
  if (state === 'listening' && mic.isActive()) {
    const levels = mic.getLevels();
    if (levels) {
      bandLevels.bass = follow(bandLevels.bass, levels.bass, dt, 0.06, 0.4);
      bandLevels.mid = follow(bandLevels.mid, levels.mid, dt, 0.06, 0.4);
      bandLevels.treble = follow(bandLevels.treble, levels.treble, dt, 0.05, 0.35);
      micTarget = clamp01(levels.overall * 1.6);

      // Peak detection: a sudden rise in overall level injects an extra
      // transient pulse on top of the smoothed envelope (a louder moment
      // should *immediately* read as brighter/bigger, not just ride the
      // slow envelope up).
      if (levels.overall - prevMicOverall > 0.12) {
        speakingPulse = clamp01(speakingPulse + 0.3);
      }
      prevMicOverall = levels.overall;
    }
  } else {
    bandLevels.bass = follow(bandLevels.bass, 0, dt, 0.2, 0.6);
    bandLevels.mid = follow(bandLevels.mid, 0, dt, 0.2, 0.6);
    bandLevels.treble = follow(bandLevels.treble, 0, dt, 0.2, 0.6);
  }

  speakingPulse *= Math.pow(0.04, dt); // fast decay back toward 0

  const target = clamp01(preset.base + Math.max(micTarget, speakingPulse));
  energy = follow(energy, target, dt, 0.35, 0.8);

  renderFrame();
  rafId = requestAnimationFrame(tick);
}

function ensureLoopRunning() {
  if (rafId) return;
  lastTime = null;
  rafId = requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function init(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
  ensureLoopRunning(); // idle breathing runs continuously for the page's lifetime
}

// 'idle' | 'thinking' | 'listening' | 'speaking'
export function setState(next) {
  if (!STATE_PRESETS[next]) return;
  state = next;
  preset = STATE_PRESETS[next];
  ensureLoopRunning();
}

export function getState() {
  return state;
}

// Speaking pulses (real timing, synthetic magnitude — see file header).
export function speakingPulseIn() {
  speakingPulse = clamp01(speakingPulse + 0.22 + Math.random() * 0.25);
}
