// In-browser OCR via Tesseract.js — loaded on demand the first time init() is called
// so the ~3 MB library never hits the initial page load on mobile.

let _worker = null;
let _initPromise = null;

function _loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Tesseract failed to load'));
    document.head.appendChild(s);
  });
}

export async function init() {
  if (_worker) return;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    await _loadTesseract();
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
