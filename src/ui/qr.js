import encodeQR from 'qr';
import decodeQR from 'qr/decode.js';
import { QRCanvas, frameLoop, rearCamera } from 'qr/dom.js';

/** QR code as an SVG data URL (crisp at any size; long-press to save on phones). */
export function qrDataUrl(text, ecc = 'medium') {
  const svg = encodeQR(text, 'svg', { ecc, border: 3 });
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/**
 * Shows a UR on an <img>: one static code when it fits, otherwise an endless animated
 * sequence of fountain-coded parts (upper case → compact alphanumeric QR mode).
 * Returns { stop }.
 */
export function playUR(img, encoder, { interval = 220 } = {}) {
  if (encoder.isSinglePart) {
    img.src = qrDataUrl(encoder.nextPart().toUpperCase());
    return { stop() {}, parts: 1 };
  }
  const show = () => {
    img.src = qrDataUrl(encoder.nextPart().toUpperCase(), 'low');
  };
  show();
  const timer = setInterval(show, interval);
  return { stop: () => clearInterval(timer), parts: encoder.seqLen };
}

/**
 * Starts the camera. onText(text) is called for every newly read QR code and returns true
 * to finish (multi-part URs keep the camera running until complete).
 * Returns { stop, next } — next() switches to another camera.
 */
export async function startScanner(video, overlay, onText) {
  const camera = await rearCamera(video);
  const canvas = new QRCanvas({ overlay });
  let stopped = false;
  let busy = false;
  let last = '';
  const cancel = frameLoop(async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const text = await camera.readFrame(canvas);
      if (typeof text === 'string' && text && text !== last && !stopped) {
        last = text;
        if (onText(text)) stop();
      }
    } catch {
      // a frame without a readable code
    } finally {
      busy = false;
    }
  }, video);
  function stop() {
    if (stopped) return;
    stopped = true;
    cancel();
    camera.stop();
  }
  async function next() {
    const devices = await camera.listDevices();
    if (devices.length < 2) return false;
    const current = video.srcObject?.getVideoTracks?.()[0]?.getSettings?.().deviceId;
    const i = devices.findIndex((d) => d.deviceId === current);
    await camera.setDevice(devices[(i + 1) % devices.length].deviceId);
    return true;
  }
  return { stop, next };
}

/** Reads a QR code from a photo or screenshot. */
export async function decodeImageFile(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return decodeQR(ctx.getImageData(0, 0, w, h), { effort: Infinity, timeLimit: 3000 });
}
