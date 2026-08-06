import { createStateMachine } from './stateMachine.js';
import * as tts      from './tts.js';
import * as camera   from './camera.js';
import * as ocr      from './ocr.js';
import * as scanPulse from './scanPulse.js';
import * as waveform  from './waveform.js';
import * as edgeGlow  from './edgeGlow.js';
import * as mic       from './micAnalyser.js';
import { announce }   from './a11y.js';
import * as reader    from './reader.js';
import { DocScanner } from './docScanner.js';

const idleBtn        = document.getElementById('idle-screen');
const activeScreen   = document.getElementById('active-screen');
const btnCancel      = document.getElementById('btn-cancel');
const btnMenu        = document.getElementById('btn-menu');
const menuDropdown   = document.getElementById('menu-dropdown');
const btnMicPill     = document.getElementById('btn-mic-pill');
const captureWrap    = document.getElementById('capture-wrap');
const btnCapture     = document.getElementById('btn-capture');
const btnUpload      = document.getElementById('btn-upload');
const uploadInput    = document.getElementById('upload-input');
const videoEl        = document.getElementById('camera-video');
const captureCanvas  = document.getElementById('capture-canvas');
const waveformCanvas = document.getElementById('waveform');
const edgeGlowCanvas = document.getElementById('edge-glow-canvas');
const scanOverlay    = document.getElementById('scan-overlay');
const captureFlash   = document.getElementById('capture-flash');

const scanner = new DocScanner(videoEl, scanOverlay);

waveform.init(waveformCanvas);
edgeGlow.init(edgeGlowCanvas);
reader.init();
tts.onEvent(type => {
  if (type === 'boundary') { edgeGlow.speakingPulseIn(); waveform.pulseIn(0.1); }
});

const SCAN_TIMEOUT_MS  = 20000;
const MIN_CONFIDENCE   = 60;
const MIN_LENGTH       = 8;
let abortController    = null;

// ── Cloud OCR via Google Vision ───────────────────────────────────────────────
// Tries the /api/ocr proxy (Google Vision DOCUMENT_TEXT_DETECTION) first.
// Returns null if the endpoint is unconfigured or the request fails so the
// caller can fall back to in-browser Tesseract.js.
async function cloudOcr(canvas) {
  try {
    const imageData = canvas.toDataURL('image/jpeg', 0.95);
    const res = await fetch('/api/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageData }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.text ? json : null;
  } catch {
    return null;
  }
}

// ── OCR text post-processing ──────────────────────────────────────────────────
// Tesseract outputs each visual line as its own \n, making every line a
// separate "paragraph" in the reader. This joins wrapped lines back together
// and re-splits only on real paragraph boundaries.
function cleanOcrText(raw) {
  if (!raw?.trim()) return '';
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').map(l => l.trim());
  const paras = [];
  let cur = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] ?? '';

    if (!line) {
      // Blank line = genuine paragraph break
      if (cur.length) { paras.push(cur.join(' ')); cur = []; }
      continue;
    }

    // Dehyphenate line-wrapped words (e.g. "recog-\nnition" → "recognition")
    if (line.endsWith('-') && next) {
      cur.push(line.slice(0, -1));
      continue;
    }

    cur.push(line);

    // Also split on sentence boundary: line ends with .!? and next starts with capital
    if (/[.!?]$/.test(line) && next && /^[A-Z"']/.test(next)) {
      paras.push(cur.join(' '));
      cur = [];
    }
  }
  if (cur.length) paras.push(cur.join(' '));

  return paras
    .filter(p => p.replace(/\s/g, '').length > 3)
    .join('\n\n');
}

const WAVEFORM_ENERGY_BY_STATE = { idle:0.16,'requesting-camera':0.45,scanning:1,reading:0.8,error:0.16 };
const GLOW_STATE_BY_APP_STATE  = { idle:'idle','requesting-camera':'thinking',scanning:'listening',reading:'speaking',error:'idle' };

const machine = createStateMachine({
  onEnter(to) {
    document.body.dataset.screen = to;
    btnMicPill.classList.toggle('is-pulsing', to === 'scanning' || to === 'reading');
    waveform.setEnergy(WAVEFORM_ENERGY_BY_STATE[to] ?? 0.16);
    edgeGlow.setState(GLOW_STATE_BY_APP_STATE[to] ?? 'idle');
    closeMenu();
    if (to === 'idle') idleBtn.focus(); else btnCancel.focus();
  },
});

function openMenu()  { menuDropdown.hidden=false; btnMenu.setAttribute('aria-expanded','true');  announce("Congrats! You found the menu, which means you don't need this app."); }
function closeMenu() { menuDropdown.hidden=true;  btnMenu.setAttribute('aria-expanded','false'); }
function sleep(ms, signal) {
  return new Promise(resolve => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(id); resolve(); });
  });
}
async function say(text, style)  { announce(text);                       await tts.speakAsync(text, { style }); }
async function sayError(text)    { announce(text, { assertive: true });  await tts.speakAsync(text, { style: 'serious' }); }
// ── Scan countdown ────────────────────────────────────────────────────────────
const _cdEl     = document.getElementById('scan-countdown');
const _cdNumEl  = document.getElementById('countdown-number');
const _cdRingEl = _cdEl?.querySelector('.countdown-ring');
let _cdInterval = null;
let _cdN        = 5;

function startCountdown() {
  stopCountdown(); // clear any previous
  _cdN = 5;
  _cdNumEl.textContent = _cdN;
  _cdRingEl.classList.remove('is-running');
  void _cdRingEl.offsetWidth; // force reflow to restart animation
  _cdRingEl.classList.add('is-running');
  _cdEl.removeAttribute('hidden');

  _cdInterval = setInterval(() => {
    _cdN--;
    _cdNumEl.textContent = Math.max(0, _cdN);

    // Bump animation on number change
    _cdNumEl.classList.remove('bump');
    void _cdNumEl.offsetWidth;
    _cdNumEl.classList.add('bump');
    setTimeout(() => _cdNumEl.classList.remove('bump'), 200);

    if (_cdN <= 0) {
      stopCountdown();
      scanner.capture(); // auto-capture when countdown ends
    }
  }, 1000);
}

function stopCountdown() {
  if (_cdInterval) { clearInterval(_cdInterval); _cdInterval = null; }
  if (_cdEl) _cdEl.setAttribute('hidden', '');
}

function cleanupScanResources() {
  stopCountdown();
  scanner.stop();
  scanPulse.stop();
  camera.stop(videoEl);
  mic.stop();
}

function triggerFlash() {
  captureFlash.classList.remove('is-flashing');
  void captureFlash.offsetWidth; // reflow to restart animation
  captureFlash.classList.add('is-flashing');
}

// Fetch welcome audio on page load and pre-load into the element so tap → play is instant
const WELCOME_TEXT  = 'Welcome! Kindly tap anywhere on your screen to scan text or an image, or tap the Upload button below to upload a document or image. I\'ll read the text aloud for you or help interpret what\'s in the image.';
const _welcomeAudio = new Audio();
let _welcomeLoaded  = false;
let _welcomeUrl     = null;
// Fetch the welcome audio blob in the background so it's ready when the user taps.
// We do NOT pre-set _welcomeAudio.src here — that's done after the unlock pattern below.
const _SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
const _welcomeReady = fetch('/api/tts', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: WELCOME_TEXT }),
}).then(async r => {
  if (r.ok) { const b = await r.blob(); _welcomeUrl = URL.createObjectURL(b); _welcomeLoaded = true; }
}).catch(() => {});

// Welcome modal
const welcomeModal  = document.getElementById('welcome-modal');
const welcomeTapBtn = document.getElementById('welcome-tap');
welcomeTapBtn.addEventListener('click', async () => {
  // iOS Safari blocks audio.play() unless it was previously played in a synchronous
  // user-gesture context. Unlock ALL three audio elements right here before any await.
  tts.unlock();      // unlocks cloudAudio used by tts.speakAsync / say()
  reader.unlock();   // unlocks _audio used by the reader's paragraph TTS
  _welcomeAudio.src = _SILENT_WAV;
  _welcomeAudio.play().catch(() => {}); // unlocks _welcomeAudio for the async play below

  welcomeModal.classList.add('is-closing');
  welcomeModal.addEventListener('animationend', () => welcomeModal.setAttribute('hidden', ''), { once: true });

  // Wait for the blob if the fetch hasn't finished yet (edge case: user tapped very fast)
  if (!_welcomeLoaded) await _welcomeReady;

  if (_welcomeLoaded) {
    // Element is already unlocked above, so this async play() works on iOS
    _welcomeAudio.src = _welcomeUrl;
    await new Promise(resolve => {
      _welcomeAudio.onended = resolve;
      _welcomeAudio.onerror = resolve;
      _welcomeAudio.play().catch(resolve);
    });
  }
  if (_welcomeUrl) { URL.revokeObjectURL(_welcomeUrl); _welcomeUrl = null; }
});

let _greeted = false;
async function handleIdleActivate() {
  if (machine.current !== 'idle') return;
  document.body.classList.add('has-tapped');
  machine.transition('requesting-camera');
  _greeted = true;

  let stream;
  try { stream = await camera.start(videoEl); }
  catch {
    await sayError('Camera permission is required. Please enable camera access and try again.');
    if (machine.current !== 'idle') machine.transition('idle');
    return;
  }
  if (machine.current !== 'requesting-camera') return;
  machine.transition('scanning');
  announce('Scanning.');
  mic.start(stream);
  ocr.init(); // preload in background

  abortController = new AbortController();

  // Say "Scanning." first, then start the countdown so the numbers begin after the voice finishes
  await tts.speakAsync('Scanning.', { style: 'instruction' });
  if (machine.current !== 'scanning') return;
  startCountdown();

  scanner.start({
    timeoutMs: SCAN_TIMEOUT_MS,
    onDocumentChange(_hasDoc) {},
    async onCapture(processedCanvas) {
      if (machine.current !== 'scanning') return;
      stopCountdown();
      triggerFlash();

      // 1. GPT-4o Vision (primary — handles both text and images)
      let result = await cloudOcr(processedCanvas);

      // 2. Tesseract.js on warp-corrected frame (fallback, text only)
      if (!result || result.text.length < MIN_LENGTH) {
        try { result = await ocr.recognize(processedCanvas); }
        catch { result = { text: '', confidence: 0 }; }
      }

      // 3. Tesseract.js on raw camera frame (last resort)
      if (result.text.length < MIN_LENGTH) {
        try {
          const raw = camera.grabFrame(videoEl, captureCanvas);
          const rawResult = await ocr.recognize(raw);
          if (rawResult.text.length >= result.text.length) result = rawResult;
        } catch {}
      }

      if (machine.current !== 'scanning') return;

      const isImage  = result.type === 'image';
      const cleaned  = isImage ? result.text : cleanOcrText(result.text);
      const imageUrl = isImage ? processedCanvas.toDataURL('image/jpeg', 0.9) : null;

      if (cleaned.length >= MIN_LENGTH) {
        onScanSuccess(cleaned, isImage, imageUrl);
      } else {
        onScanTimeout();
      }
    },
    onTimeout() {
      if (machine.current === 'scanning') onScanTimeout();
    },
  });

  // Countdown circle is tappable for early manual capture
  _cdEl.onclick = () => { stopCountdown(); scanner.capture(); };
}

function onScanSuccess(text, isImage = false, imageUrl = null) {
  cleanupScanResources();
  machine.transition('idle');
  const title = isImage ? 'Image Description' : 'Scanned Document';
  reader.open(text, title, () => { idleBtn.focus(); }, imageUrl);
}

async function onScanTimeout() {
  cleanupScanResources(); machine.transition('error');
  await sayError('I could not detect any readable text. Please move the device closer and try again.');
  if (machine.current === 'error') machine.transition('idle');
}

async function handleUpload(e) {
  const file = e.target.files?.[0];
  uploadInput.value = '';
  if (!file || machine.current !== 'idle') return;

  machine.transition('scanning');

  // Say "Loading" and process the file in parallel to avoid sequential delay
  let result = { text: '', type: 'text', imageUrl: null };
  try {
    const ext = file.name.split('.').pop().toLowerCase();
    const [, extracted] = await Promise.all([
      say('Loading document.', 'instruction'),
      ext === 'docx' || file.type.includes('wordprocessingml') ? extractDocx(file).then(t => ({ text: t }))
      : ext === 'pdf' || file.type === 'application/pdf'       ? extractPdf(file).then(t => ({ text: t }))
      : extractImage(file),
    ]);
    result = extracted;
  } catch {
    cleanupScanResources(); machine.transition('error');
    await sayError('Could not read that file. Please try a different document.');
    if (machine.current === 'error') machine.transition('idle');
    return;
  }

  if (!result.text || result.text.length < MIN_LENGTH) {
    cleanupScanResources(); machine.transition('error');
    await sayError('No readable text found in the document.');
    if (machine.current === 'error') machine.transition('idle');
    return;
  }

  if (machine.current !== 'scanning') return;

  machine.transition('idle');
  const title = result.type === 'image' ? 'Image Description' : file.name;
  reader.open(result.text, title, () => { idleBtn.focus(); }, result.imageUrl);
}

async function extractImage(file) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  await new Promise((res, rej) => { img.onload=res; img.onerror=rej; img.src=url; });
  URL.revokeObjectURL(url);
  captureCanvas.width=img.naturalWidth; captureCanvas.height=img.naturalHeight;
  captureCanvas.getContext('2d').drawImage(img, 0, 0);

  const imageUrl = captureCanvas.toDataURL('image/jpeg', 0.9);

  // Try GPT-4o Vision first (handles text extraction AND image description)
  const cloudResult = await cloudOcr(captureCanvas);
  if (cloudResult?.text?.length >= MIN_LENGTH) {
    const isImage = cloudResult.type === 'image';
    const text    = isImage ? cloudResult.text : cleanOcrText(cloudResult.text);
    return { text, type: cloudResult.type || 'text', imageUrl };
  }

  // Fallback to Tesseract.js
  await ocr.init();
  return { text: cleanOcrText((await ocr.recognize(captureCanvas)).text), type: 'text', imageUrl };
}

async function _loadPdfJs() {
  if (window['pdfjs-dist/build/pdf']) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function _loadMammoth() {
  if (window.mammoth) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/mammoth@1/mammoth.browser.min.js';
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function extractPdf(file) {
  await _loadPdfJs();
  const pdfjsLib = window['pdfjs-dist/build/pdf'];
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;

  // First try embedded text (typed/digital PDFs — free, instant, no API needed)
  const embPages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc   = await page.getTextContent();
    const txt  = tc.items
      .filter(it => typeof it.str === 'string')
      .map(it => it.str + (it.hasEOL ? '\n' : ''))
      .join('');
    embPages.push(txt.trim());
  }
  if (embPages.join('').length / pdf.numPages >= 30) {
    return embPages.join('\n\n');   // digital PDF — done
  }

  // Scanned/image PDF — fall back to OCR per page
  const ocrPages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    if (machine.current !== 'scanning') break;
    const page = await pdf.getPage(i);
    const vp   = page.getViewport({ scale: 2 });
    const cv   = document.createElement('canvas');
    cv.width = vp.width; cv.height = vp.height;
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    await ocr.init();
    const result = await ocr.recognize(cv);
    if (result.text) ocrPages.push(cleanOcrText(result.text));
  }
  return ocrPages.join('\n\n');
}

async function extractDocx(file) {
  await _loadMammoth();
  const result = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return result.value?.trim() || '';
}

function handleCancel() {
  if (machine.current === 'idle') return;
  abortController?.abort();
  tts.cancelAll();
  cleanupScanResources();
  machine.transition('idle');
}

idleBtn.addEventListener('click', handleIdleActivate);
btnCancel.addEventListener('click', handleCancel);
btnMicPill.addEventListener('click', handleCancel);
btnUpload.addEventListener('click', e => { e.stopPropagation(); uploadInput.click(); });
uploadInput.addEventListener('change', handleUpload);
btnMenu.addEventListener('click', e => { e.stopPropagation(); menuDropdown.hidden ? openMenu() : closeMenu(); });
document.addEventListener('click', e => {
  if (!menuDropdown.hidden && !menuDropdown.contains(e.target) && e.target !== btnMenu) closeMenu();
});
window.addEventListener('pagehide', () => {
  abortController?.abort(); scanner.stop(); camera.stop(videoEl); scanPulse.stop(); mic.stop(); ocr.terminate();
});

