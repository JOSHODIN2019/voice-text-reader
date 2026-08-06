import * as cloudTts from './ttsCloud.js';

const synth = window.speechSynthesis;

let queue = [];
let speaking = false;
let pendingResolve = null;
let pauseTimeoutId = null;
let epoch = 0;
const prefetchCache = new Map();

const cloudAudio = new Audio();
let currentObjectUrl = null;
let usingCloudAudio = false;

const listeners = new Set();
function emit(type) { listeners.forEach(fn => fn(type)); }
export function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }

const PAUSE_MS = {
  sentence:    420,
  ellipsis:    600,
  paragraph:   700,
  forcedWrap:   80,
};

function wrapIfTooLong(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const words = text.split(' ');
  const out = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxLen && current) {
      out.push(current.trim());
      current = word;
    } else {
      current = (current + ' ' + word).trim();
    }
  }
  if (current) out.push(current.trim());
  return out;
}

const MAX_CHUNK_LEN = 200;

function buildChunks(text) {
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) paragraphs.push(text.trim());

  const merged = [];
  paragraphs.forEach((para, pIdx) => {
    const sentences = (para.match(/[^.!?…]+(?:\.\.\.|…|[.!?]+)?/g) || [para])
      .map(s => s.trim())
      .filter(Boolean);

    sentences.forEach((sentence, sIdx) => {
      const isLastInParagraph = sIdx === sentences.length - 1;
      const isLastParagraph   = pIdx === paragraphs.length - 1;
      let pause = sentence.endsWith('…') ? PAUSE_MS.ellipsis : PAUSE_MS.sentence;
      if (isLastInParagraph && !isLastParagraph) pause = PAUSE_MS.paragraph;
      merged.push({ text: sentence, pauseAfterMs: pause });
    });
  });

  const final = [];
  for (const chunk of merged) {
    const pieces = wrapIfTooLong(chunk.text, MAX_CHUNK_LEN);
    pieces.forEach((piece, i) => {
      const isLast = i === pieces.length - 1;
      final.push({ text: piece, pauseAfterMs: isLast ? chunk.pauseAfterMs : PAUSE_MS.forcedWrap });
    });
  }
  return final.filter(c => c.text.trim().length > 0);
}

const BASE_RATE  = 0.82;
const BASE_PITCH = 1.0;
const CLOUD_BASE_RATE = 0.97;

const STYLE_PRESETS = {
  greeting:    { rate: -0.05, pitch:  0.06 },
  instruction: { rate:  0,    pitch:  0    },
  informative: { rate:  0,    pitch: -0.02 },
  brightNews:  { rate:  0.03, pitch:  0.07 },
  serious:     { rate: -0.07, pitch: -0.05 },
  question:    { rate: -0.02, pitch:  0.05 },
};

function inferStyle(text) {
  const trimmed = text.trim();
  if (trimmed.endsWith('?')) return 'question';
  if (trimmed.endsWith('!')) return 'brightNews';
  return 'informative';
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

let currentChunk = null;

function startSynthesis(chunk) {
  const controller = new AbortController();
  chunk._abort = controller;
  const promise = cloudTts.synthesize(chunk.text, { signal: controller.signal });
  promise.catch(() => {});
  prefetchCache.set(chunk, promise);
  return promise;
}

function prefetchNext() {
  const next = queue[0];
  if (!next || prefetchCache.has(next) || cloudTts.isUnavailable()) return;
  startSynthesis(next);
}

function finishChunk(chunk) {
  if (chunk.pauseAfterMs > 0) {
    pauseTimeoutId = setTimeout(() => { pauseTimeoutId = null; pump(); }, chunk.pauseAfterMs);
  } else {
    pump();
  }
}

function playCloudAudio(audioUrl, rate, chunk, myEpoch) {
  return new Promise(resolveDone => {
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = audioUrl;
    usingCloudAudio = true;

    cloudAudio.src = audioUrl;
    cloudAudio.playbackRate = rate;
    cloudAudio.ontimeupdate = () => emit('boundary');
    cloudAudio.onended = () => {
      usingCloudAudio = false;
      finishChunk(chunk);
      resolveDone();
    };
    cloudAudio.onerror = () => {
      usingCloudAudio = false;
      if (myEpoch === epoch) speakWithBrowserVoice(chunk);
      resolveDone();
    };
    cloudAudio.play().catch(() => {
      usingCloudAudio = false;
      if (myEpoch === epoch) speakWithBrowserVoice(chunk);
      resolveDone();
    });
  });
}

// Uses the browser's OS default voice — same voice the document reader uses,
// so welcome/instructions/errors all sound consistent with document reading.
function speakWithBrowserVoice(chunk) {
  const preset = STYLE_PRESETS[chunk.style] || STYLE_PRESETS.informative;
  const jitter = (Math.random() - 0.5) * 0.03;

  const utter = new SpeechSynthesisUtterance(chunk.text);
  utter.rate  = clamp(BASE_RATE + preset.rate + jitter, 0.75, 1.08);
  utter.pitch = clamp(BASE_PITCH + preset.pitch, 0.85, 1.2);
  // No voice override — browser default matches the document reader's voice
  utter.onboundary = () => emit('boundary');
  utter.onend      = () => finishChunk(chunk);
  utter.onerror    = () => pump();
  synth.speak(utter);
}

async function pump() {
  if (queue.length === 0) {
    const wasSpeaking = speaking;
    speaking = false;
    if (wasSpeaking) emit('end');
    const resolve = pendingResolve;
    pendingResolve = null;
    resolve?.();
    return;
  }
  const wasSpeaking = speaking;
  speaking = true;
  if (!wasSpeaking) emit('start');

  const myEpoch = epoch;
  const chunk   = queue.shift();
  currentChunk  = chunk;

  if (!cloudTts.isUnavailable()) {
    const promise = prefetchCache.get(chunk) || startSynthesis(chunk);
    prefetchCache.delete(chunk);
    try {
      const audioUrl = await promise;
      if (myEpoch !== epoch) return;
      const preset = STYLE_PRESETS[chunk.style] || STYLE_PRESETS.informative;
      const rate = clamp(CLOUD_BASE_RATE + preset.rate, 0.75, 1.2);
      await playCloudAudio(audioUrl, rate, chunk, myEpoch);
    } catch {
      if (myEpoch === epoch) speakWithBrowserVoice(chunk);
    }
    prefetchNext();
  } else {
    speakWithBrowserVoice(chunk);
  }
}

export function speakAsync(text, { style } = {}) {
  const resolvedStyle = style || inferStyle(text);
  return new Promise(resolve => {
    const chunks = buildChunks(text).map(c => ({ ...c, style: resolvedStyle }));
    queue.push(...chunks);
    pendingResolve = resolve;
    if (!speaking) pump();
  });
}

export function cancelAll() {
  epoch++;
  const wasSpeaking = speaking;
  currentChunk?._abort?.abort();
  for (const chunk of queue) chunk._abort?.abort();
  currentChunk = null;
  prefetchCache.clear();
  queue = [];
  if (pauseTimeoutId) {
    clearTimeout(pauseTimeoutId);
    pauseTimeoutId = null;
  }
  synth.cancel();
  if (usingCloudAudio) {
    cloudAudio.pause();
    cloudAudio.removeAttribute('src');
    usingCloudAudio = false;
  }
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
  speaking = false;
  if (wasSpeaking) emit('end');
  const resolve = pendingResolve;
  pendingResolve = null;
  resolve?.();
}

export function isSpeaking() { return speaking; }
