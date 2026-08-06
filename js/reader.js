const synth = window.speechSynthesis;

let _words          = [];
let _paras          = [];
let _charToWord     = new Map();
let _wordIdx        = -1;
let _paraIdx        = 0;
let _uttBase        = 0;
let _status         = 'stopped';
let _rate           = 1;
let _activeId       = 0;
let _onClose        = null;
let _ready          = false;
let _fallbackTimers = [];

// Cloud TTS audio element
const _audio = new Audio();
let _audioUrl    = null;
let _usingCloud  = false;
let _rafId       = null;

// ─── Public ───────────────────────────────────────────────────────────────────

export function init() {
  if (_ready) return;
  _ready = true;
  _el('rdr-back').addEventListener('click', close);
  _el('rdr-playpause').addEventListener('click', playPause);
  _el('rdr-stop').addEventListener('click', stop);
  _el('rdr-speed').addEventListener('change', e => setSpeed(e.target.value));
  _el('rdr-jump').addEventListener('change', e => {
    const v = e.target.value;
    if (v !== '') { jumpTo(parseInt(v, 10)); e.target.value = ''; }
  });
  _el('rdr-overlay').addEventListener('click', e => {
    if (e.target === _el('rdr-overlay')) close();
  });
}

export function open(text, filename, onClose) {
  _onClose = onClose ?? null;
  _status  = 'stopped';
  _wordIdx = -1;
  _paraIdx = 0;
  _uttBase = 0;
  _rate    = 1;

  _parseText(text);
  _renderText();
  _buildJumpMenu();

  _el('rdr-title').textContent = (filename || 'Document').replace(/\.[^/.]+$/, '');
  _el('rdr-speed').value = '1';

  const overlay = _el('rdr-overlay');
  overlay.removeAttribute('hidden');
  overlay.getBoundingClientRect();
  overlay.classList.add('is-open');

  _updateBtn();
  _speakFrom(0, 0);
}

export function close() {
  _cancelSynth();
  const overlay = _el('rdr-overlay');
  overlay.classList.remove('is-open');
  overlay.addEventListener('transitionend', () => overlay.setAttribute('hidden', ''), { once: true });
  const cb = _onClose;
  _onClose = null;
  cb?.();
}

export function playPause() {
  _status === 'playing' ? _pause() : _resume();
}

export function stop() {
  _cancelSynth();
  _clearHL();
  _wordIdx = -1;
  _paraIdx = 0;
  _status  = 'stopped';
  _updateBtn();
  const t = _el('rdr-text');
  if (t) t.scrollTop = 0;
}

export function setSpeed(val) {
  const r = parseFloat(val);
  if (!isFinite(r)) return;
  _rate = r;
  if (_usingCloud && _status === 'playing') {
    _audio.playbackRate = r; // audio element handles rate change live — no restart needed
  } else if (!_usingCloud && _status === 'playing') {
    const pi = _paraIdx, wi = _wordIdx;
    _cancelSynth();
    wi >= 0 ? _speakFromWord(pi, wi) : _speakFrom(pi, 0);
  }
}

export function jumpTo(paraIdx) {
  if (paraIdx < 0 || paraIdx >= _paras.length) return;
  const active = _status !== 'stopped';
  _cancelSynth();
  _clearHL();
  _paraIdx = paraIdx;
  _wordIdx = _paras[paraIdx].fw;
  _scrollTo(_wordIdx);
  if (active) _speakFrom(paraIdx, 0);
}

// ─── Parse ────────────────────────────────────────────────────────────────────

function _parseText(text) {
  _words      = [];
  _paras      = [];
  _charToWord = new Map();

  const re = /[^\n]+/g;
  let m, wi = 0;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    if (!raw.trim()) continue;
    const abs0 = m.index;
    const fw   = wi;
    const wr   = /\S+/g;
    let wm;
    while ((wm = wr.exec(raw)) !== null) {
      const a = abs0 + wm.index;
      _words.push({ absStart: a, el: null });
      _charToWord.set(a, wi++);
    }
    _paras.push({ text: raw, absStart: abs0, fw, lw: wi - 1 });
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────

function _renderText() {
  const box = _el('rdr-text');
  box.innerHTML = '';
  let wi = 0;
  for (const para of _paras) {
    const p = document.createElement('p');
    p.className = 'rdr-para';
    let cur = 0;
    const wr = /\S+/g;
    let wm;
    while ((wm = wr.exec(para.text)) !== null) {
      if (wm.index > cur) p.appendChild(document.createTextNode(para.text.slice(cur, wm.index)));
      const sp = document.createElement('span');
      sp.className = 'rdr-word';
      sp.textContent = wm[0];
      _words[wi++].el = sp;
      p.appendChild(sp);
      cur = wm.index + wm[0].length;
    }
    if (cur < para.text.length) p.appendChild(document.createTextNode(para.text.slice(cur)));
    box.appendChild(p);
  }
}

function _buildJumpMenu() {
  const sel = _el('rdr-jump');
  sel.innerHTML = '<option value="">Jump to…</option>';
  _paras.forEach((p, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = `${i + 1}. ${p.text.trim().slice(0, 45)}${p.text.length > 45 ? '…' : ''}`;
    sel.appendChild(o);
  });
}

// ─── Speech ───────────────────────────────────────────────────────────────────

async function _speakFrom(pi, offset) {
  if (pi >= _paras.length) { _status = 'stopped'; _clearHL(); _updateBtn(); return; }
  _paraIdx = pi;
  _status  = 'playing';
  const para = _paras[pi];
  const txt  = para.text.slice(offset);
  if (!txt.trim()) { _speakFrom(pi + 1, 0); return; }
  _uttBase = para.absStart + offset;

  const myId = ++_activeId;

  // Try OpenAI TTS (cloud) first
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: txt }),
    });

    if (_activeId !== myId || _status !== 'playing') return;

    if (res.ok) {
      const blob = await res.blob();
      if (_activeId !== myId || _status !== 'playing') return;

      if (_audioUrl) URL.revokeObjectURL(_audioUrl);
      _audioUrl = URL.createObjectURL(blob);
      _usingCloud = true;

      _audio.src = _audioUrl;
      _audio.playbackRate = _rate;

      _audio.onended = () => {
        if (_activeId !== myId) return;
        _stopRaf();
        _usingCloud = false;
        if (_status === 'playing') _speakFrom(pi + 1, 0);
      };

      _audio.onerror = () => {
        if (_activeId !== myId) return;
        _stopRaf();
        _usingCloud = false;
        if (_status === 'playing') _speakFrom(pi + 1, 0);
      };

      try { await _audio.play(); } catch { return; }
      if (_activeId !== myId || _status !== 'playing') return;
      _startRafHighlight(para, myId);
      return;
    }
  } catch {}

  if (_activeId !== myId || _status !== 'playing') return;

  // Fallback: browser speech synthesis
  _usingCloud = false;
  _speakWithBrowser(pi, para, txt, myId);
}

function _speakWithBrowser(pi, para, txt, myId) {
  const utt = new SpeechSynthesisUtterance(txt);
  utt.rate  = _rate;

  let boundaryFired = false;

  utt.addEventListener('boundary', e => {
    if (e.name !== 'word' || _status !== 'playing' || _activeId !== myId) return;
    boundaryFired = true;
    const w = _resolve(_uttBase + e.charIndex);
    if (w !== undefined && w !== _wordIdx) _highlight(w);
  });

  utt.addEventListener('start', () => {
    const checkId = setTimeout(() => {
      if (boundaryFired || _activeId !== myId || _status !== 'playing') return;
      const CPS = 13 * _rate;
      for (let wi = para.fw; wi <= para.lw; wi++) {
        const word = _words[wi];
        if (!word) continue;
        const charOff = word.absStart - _uttBase;
        if (charOff < 0) continue;
        const id = setTimeout(() => {
          if (_activeId === myId && _status === 'playing') _highlight(wi);
        }, Math.round((charOff / CPS) * 1000));
        _fallbackTimers.push(id);
      }
    }, 500);
    _fallbackTimers.push(checkId);
  });

  utt.addEventListener('end', () => {
    _clearFallbackTimers();
    if (_activeId !== myId || _status !== 'playing') return;
    _speakFrom(pi + 1, 0);
  });

  utt.addEventListener('error', e => {
    _clearFallbackTimers();
    if (e.error === 'canceled' || e.error === 'interrupted') return;
    if (_activeId === myId && _status === 'playing') _speakFrom(pi + 1, 0);
  });

  synth.speak(utt);
}

function _speakFromWord(pi, wi) {
  const w      = _words[wi];
  const para   = _paras[pi];
  const offset = Math.max(0, w.absStart - para.absStart);
  _speakFrom(pi, offset);
}

function _pause() {
  if (_status !== 'playing') return;
  _status = 'paused';
  _stopRaf();
  if (_usingCloud) {
    _audio.pause(); // keeps src + currentTime so resume continues from same position
  } else {
    _clearFallbackTimers();
    _activeId++;
    try { synth.cancel(); } catch {}
  }
  _updateBtn();
}

function _resume() {
  if (_status === 'playing') return;
  if (_usingCloud && _audio.src && !_audio.ended) {
    _status = 'playing';
    _audio.playbackRate = _rate;
    _audio.play().catch(() => { _usingCloud = false; _resumeFromWord(); });
    _startRafHighlight(_paras[_paraIdx], _activeId);
    _updateBtn();
  } else {
    _usingCloud = false;
    _resumeFromWord();
    _updateBtn();
  }
}

function _resumeFromWord() {
  _status = 'playing';
  if (_wordIdx >= 0) {
    for (let pi = 0; pi < _paras.length; pi++) {
      if (_wordIdx >= _paras[pi].fw && _wordIdx <= _paras[pi].lw) {
        _speakFromWord(pi, _wordIdx);
        return;
      }
    }
  }
  _speakFrom(_paraIdx >= 0 ? _paraIdx : 0, 0);
}

// ─── RAF word highlight (cloud audio) ────────────────────────────────────────

function _startRafHighlight(para, myId) {
  _stopRaf();
  const CPS = 13; // estimated chars/sec in TTS audio at rate=1; currentTime already reflects playbackRate

  function loop() {
    if (_activeId !== myId || _status !== 'playing' || !_usingCloud) return;
    const charsElapsed = _audio.currentTime * CPS;
    let found = -1;
    for (let wi = para.fw; wi <= para.lw; wi++) {
      const word = _words[wi];
      if (!word) continue;
      const charOff = word.absStart - _uttBase;
      if (charOff <= charsElapsed) found = wi;
      else break;
    }
    if (found >= 0 && found !== _wordIdx) _highlight(found);
    _rafId = requestAnimationFrame(loop);
  }

  _rafId = requestAnimationFrame(loop);
}

function _stopRaf() {
  if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
}

// ─── Timers (browser synth fallback) ─────────────────────────────────────────

function _clearFallbackTimers() {
  _fallbackTimers.forEach(clearTimeout);
  _fallbackTimers = [];
}

function _cancelSynth() {
  _activeId++;
  _clearFallbackTimers();
  _stopRaf();
  _usingCloud = false;
  _audio.pause();
  _audio.removeAttribute('src');
  if (_audioUrl) { URL.revokeObjectURL(_audioUrl); _audioUrl = null; }
  try { synth.cancel(); } catch {}
}

// ─── Highlight ────────────────────────────────────────────────────────────────

function _highlight(wi) {
  if (_wordIdx >= 0) _words[_wordIdx]?.el?.classList.remove('active');
  _wordIdx = wi;
  const el = _words[wi]?.el;
  if (!el) return;
  el.classList.add('active');
  _scrollTo(wi);
}

function _clearHL() {
  if (_wordIdx >= 0) _words[_wordIdx]?.el?.classList.remove('active');
  _wordIdx = -1;
}

function _scrollTo(wi) {
  const el  = _words[wi]?.el;
  const box = _el('rdr-text');
  if (!el || !box) return;
  const er = el.getBoundingClientRect();
  const br = box.getBoundingClientRect();
  if (er.top < br.top + 60 || er.bottom > br.bottom - 60) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

// ─── Word resolution ──────────────────────────────────────────────────────────

function _resolve(abs) {
  let i = _charToWord.get(abs);
  if (i !== undefined) return i;
  for (let d = 1; d <= 8; d++) {
    i = _charToWord.get(abs + d); if (i !== undefined) return i;
    i = _charToWord.get(abs - d); if (i !== undefined) return i;
  }
  let lo = 0, hi = _words.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    _words[mid].absStart <= abs ? lo = mid : hi = mid - 1;
  }
  return lo;
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function _updateBtn() {
  const btn = _el('rdr-playpause');
  if (!btn) return;
  const playing = _status === 'playing';
  btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  btn.querySelector('.i-play').style.display  = playing ? 'none' : '';
  btn.querySelector('.i-pause').style.display = playing ? ''     : 'none';
}

function _el(id) { return document.getElementById(id); }
