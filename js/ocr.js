// In-browser OCR via Tesseract.js (free, no API key, no billing required).

let _worker = null;
let _initPromise = null;

export async function init() {
  if (_worker) return;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    _worker = await window.Tesseract.createWorker('eng', 1, { logger: () => {} });
  })();
  await _initPromise;
}

export async function recognize(canvasEl) {
  if (!_worker) await init();
  const { data } = await _worker.recognize(canvasEl);
  return {
    text:       (data.text       || '').trim(),
    confidence:  data.confidence  ?? 0,
  };
}

export async function terminate() {
  if (_worker) {
    try { await _worker.terminate(); } catch {}
    _worker = null;
    _initPromise = null;
  }
}
