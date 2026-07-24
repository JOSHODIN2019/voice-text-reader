let currentStream = null;

const VIDEO_CONSTRAINTS = {
  facingMode: { ideal: 'environment' },
  width: { ideal: 1920 },
  height: { ideal: 1080 },
};

// Requests camera + mic together (one combined permission prompt) so the
// edge glow can react to real audio while listening. getUserMedia is
// all-or-nothing per call though — if the browser/user denies audio
// specifically, the *whole* combined call rejects, which would otherwise
// take the core scanning feature down with it. So on failure, retry
// video-only: the mic is purely a visual enhancement and must never be
// able to break OCR scanning.
export async function start(videoEl) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS, audio: true });
  } catch {
    stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS, audio: false });
  }
  currentStream = stream;
  videoEl.srcObject = stream;
  await videoEl.play();
  return stream;
}

export function stop(videoEl) {
  currentStream?.getTracks().forEach(track => track.stop());
  currentStream = null;
  if (videoEl) videoEl.srcObject = null;
}

export function grabFrame(videoEl, canvasEl) {
  const ctx = canvasEl.getContext('2d', { willReadFrequently: true });
  canvasEl.width = videoEl.videoWidth;
  canvasEl.height = videoEl.videoHeight;
  ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
  return canvasEl;
}
