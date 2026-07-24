// Real microphone-driven audio analysis for the "listening" glow state.
// Unlike speechSynthesis (no amplitude access at all — see js/tts.js), a
// microphone MediaStream genuinely supports a Web Audio AnalyserNode, so
// everything this module reports is real frequency-domain data, not
// simulated. Per-band smoothing/attack-release is layered on top by
// js/edgeGlow.js — this module just reports the raw (but bucketed) levels.

let audioCtx = null;
let analyser = null;
let dataArray = null;
let sourceNode = null;

// Call with a MediaStream that already has an audio track (e.g. from
// camera.start(), which requests video+audio together). Returns false
// (without throwing) if the stream has no audio track, so callers can fall
// back to simulated "listening" energy without breaking the core app.
export function start(stream) {
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) return false;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  sourceNode = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0; // edgeGlow.js does its own attack/release envelope
  dataArray = new Uint8Array(analyser.frequencyBinCount);
  sourceNode.connect(analyser);
  return true;
}

// Returns { bass, mid, treble, overall }, each 0..1, or null if no mic is active.
export function getLevels() {
  if (!analyser) return null;
  analyser.getByteFrequencyData(dataArray);

  const n = dataArray.length;
  const bassEnd = Math.floor(n * 0.08);
  const midEnd = Math.floor(n * 0.35);

  let bass = 0, mid = 0, treble = 0;
  for (let i = 0; i < bassEnd; i++) bass += dataArray[i];
  for (let i = bassEnd; i < midEnd; i++) mid += dataArray[i];
  for (let i = midEnd; i < n; i++) treble += dataArray[i];

  bass /= bassEnd * 255;
  mid /= (midEnd - bassEnd) * 255;
  treble /= (n - midEnd) * 255;

  return { bass, mid, treble, overall: (bass + mid + treble) / 3 };
}

export function isActive() {
  return !!analyser;
}

export function stop() {
  sourceNode?.disconnect();
  sourceNode = null;
  analyser = null;
  dataArray = null;
  audioCtx?.close();
  audioCtx = null;
}
