const STATES = ['idle', 'requesting-camera', 'scanning', 'reading', 'error'];

export function createStateMachine({ onEnter } = {}) {
  let current = 'idle';
  return {
    get current() {
      return current;
    },
    transition(to, payload) {
      if (!STATES.includes(to)) {
        throw new Error(`Unknown state: ${to}`);
      }
      const from = current;
      current = to;
      onEnter?.(to, from, payload);
    },
  };
}
