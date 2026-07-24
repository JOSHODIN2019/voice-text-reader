const politeEl = document.getElementById('status-polite');
const assertiveEl = document.getElementById('status-assertive');

export function announce(text, { assertive = false } = {}) {
  const el = assertive ? assertiveEl : politeEl;
  el.textContent = '';
  setTimeout(() => {
    el.textContent = text;
  }, 50);
}
