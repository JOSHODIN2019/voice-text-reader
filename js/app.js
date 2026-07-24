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
function cleanupScanResources() {
  scanner.stop();
  btnCapture.classList.remove('is-visible', 'has-doc');
  captureWrap.hidden = true;
  scanPulse.stop();
  camera.stop(videoEl);
  mic.stop();
}

function triggerFlash() {
  captureFlash.classList.remove('is-flashing');
  void captureFlash.offsetWidth; // reflow to restart animation
  captureFlash.classList.add('is-flashing');
}

async function handleIdleActivate() {
  if (machine.current !== 'idle') return;
  document.body.classList.add('has-tapped');
  machine.transition('requesting-camera');
  let stream;
  try { stream = await camera.start(videoEl); }
  catch {
    await sayError('Camera permission is required for scanning text. Please enable camera access and try again.');
    if (machine.current !== 'idle') machine.transition('idle');
    return;
  }
  if (machine.current !== 'requesting-camera') return;
  await say('Camera opened. Point the camera at a document.', 'instruction');
  if (machine.current !== 'requesting-camera') return;
  machine.transition('scanning');
  mic.start(stream);
  await ocr.init(); // preload OCR worker while user aims camera

  abortController = new AbortController();

  // Show capture button immediately — user can always tap to capture,
  // regardless of whether automatic document detection has fired
  captureWrap.hidden = false;
  requestAnimationFrame(() => btnCapture.classList.add('is-visible'));

  scanner.start({
    timeoutMs: SCAN_TIMEOUT_MS,
    onDocumentChange(hasDoc) {
      // Pulse the button when corners are locked on a document
      btnCapture.classList.toggle('has-doc', hasDoc);
    },
    async onCapture(processedCanvas) {
      if (machine.current !== 'scanning') return;
      triggerFlash();

      // 1. Google Vision (best accuracy — full punctuation, no missed words)
      let result = await cloudOcr(processedCanvas);

      // 2. Tesseract.js on warp-corrected frame (free in-browser fallback)
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
      const cleaned = cleanOcrText(result.text);
      if (cleaned.length >= MIN_LENGTH) {
        onScanSuccess(cleaned);
      } else {
        onScanTimeout();
      }
    },
    onTimeout() {
      if (machine.current === 'scanning') onScanTimeout();
    },
  });

  // Capture button is always tappable during scanning
  btnCapture.onclick = () => scanner.capture();
}

function onScanSuccess(text) {
  cleanupScanResources();
  machine.transition('idle');
  reader.open(text, 'Scanned Document', () => { idleBtn.focus(); });
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
  await say('Loading document.', 'instruction');
  if (machine.current !== 'scanning') return;

  let text = '';
  try {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'docx' || file.type.includes('wordprocessingml')) {
      text = await extractDocx(file);
    } else if (ext === 'pdf' || file.type === 'application/pdf') {
      text = await extractPdf(file);
    } else {
      text = await extractImage(file);
    }
  } catch {
    cleanupScanResources(); machine.transition('error');
    await sayError('Could not read that file. Please try a different document.');
    if (machine.current === 'error') machine.transition('idle');
    return;
  }

  if (!text || text.length < MIN_LENGTH) {
    cleanupScanResources(); machine.transition('error');
    await sayError('No readable text found in the document.');
    if (machine.current === 'error') machine.transition('idle');
    return;
  }

  if (machine.current !== 'scanning') return;

  // Return app to idle, then open the reader overlay on top
  machine.transition('idle');
  reader.open(text, file.name, () => {
    // reader closed — app is already idle, just re-focus the idle button
    idleBtn.focus();
  });
}

async function extractImage(file) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  await new Promise((res, rej) => { img.onload=res; img.onerror=rej; img.src=url; });
  URL.revokeObjectURL(url);
  captureCanvas.width=img.naturalWidth; captureCanvas.height=img.naturalHeight;
  captureCanvas.getContext('2d').drawImage(img, 0, 0);
  await ocr.init();
  return cleanOcrText((await ocr.recognize(captureCanvas)).text);
}

async function extractPdf(file) {
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

(async function welcomeOnLoad() {
  try {
    await say('Good day. Kindly tap anywhere on the screen to begin. Then point your device toward the text you would like me to read.', 'greeting');
  } catch { /* iOS Safari blocks speech before user gesture */ }
})();
