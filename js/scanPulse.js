let ctx = null;
let intervalId = null;

function beep() {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 880;
  osc.type = 'sine';
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.2);
}

export function start() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  beep();
  intervalId = setInterval(beep, 1000);
}

export function stop() {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
  ctx?.close();
  ctx = null;
}
