// Thin client for the serverless TTS proxy (see api/tts.js) — never talks
// to the TTS provider directly, since that would mean shipping the API key
// to the browser. Every failure mode throws; js/tts.js is responsible for
// catching and falling back to the built-in speechSynthesis voice so a
// missing key, a network blip, or quota exhaustion can never make the app
// go silent.

let unavailableForSession = false;

export function isUnavailable() {
  return unavailableForSession;
}

// Without a bounded timeout, one slow/hanging upstream request stalls the
// whole app waiting on it — measured this directly: a quota-exceeded
// account that responds slowly (rather than with a fast error) left a
// single short line stuck for ~13s before Vercel's own function timeout
// eventually surfaced it. This timeout is well under that, so a hung
// request fails fast and falls back instead of blocking everything.
const TIMEOUT_MS = 6000;

// { signal } lets a caller abort an in-flight request (used by tts.js on
// cancelAll, so a stopped reading doesn't keep paying for audio no one
// will hear).
export async function synthesize(text, { signal } = {}) {
  if (unavailableForSession) throw new Error('cloud-tts-unavailable');

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;

  let res;
  try {
    res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: combinedSignal,
    });
  } catch (err) {
    // Only our own timeout firing is a real health signal about the
    // upstream (worth giving up on for the rest of the session); a cancel
    // initiated by the caller's own signal says nothing about whether the
    // upstream is fine, so it must not be treated the same way.
    if (timeoutController.signal.aborted) unavailableForSession = true;
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (res.status === 503) {
    unavailableForSession = true; // no key configured — stop retrying for the rest of this session
    throw new Error('cloud-tts-not-configured');
  }
  if (!res.ok) {
    // Any upstream/server-side failure (quota exhausted, provider outage,
    // etc.) — also stop retrying for the rest of this session. Without
    // this, every single chunk would re-attempt a real network round trip
    // to a known-broken endpoint before falling back, adding several
    // seconds of latency to every spoken line instead of just the first.
    if (res.status >= 500) unavailableForSession = true;
    throw new Error(`cloud-tts-failed-${res.status}`);
  }

  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
