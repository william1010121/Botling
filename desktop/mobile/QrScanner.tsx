// Scans the desktop's pairing QR code inside the page, so the home-screen app (iOS keeps its own storage apart
// from Safari, and the Camera app would open the link in Safari, not here) can pair on its own. The camera opens
// only from the user's tap (getUserMedia needs a user gesture and HTTPS), shows inline (playsInline: iOS would
// otherwise go full screen), is read here frame by frame with jsQR, and stops as soon as a code is read or the
// sheet closes. Nothing leaves the page: the decoded text goes to onResult.
import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';

/** The longest side of the frame given to the decoder: enough for a QR code on a screen, light enough for a phone. */
const SCAN_SIZE = 640;

/** What to tell the user when the camera does not open. */
export function cameraError(error: unknown): string {
  const name = (error as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera access is off for Botling. Allow it in Settings (Safari › Camera), or paste the pairing link instead.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found. Paste the pairing link instead.';
  if (name === 'NotReadableError') return 'The camera is in use by another app. Close it and try again, or paste the pairing link.';
  if (name === 'Unsupported') return 'This browser cannot open the camera here. Paste the pairing link instead.';
  return 'The camera could not start. Try again, or paste the pairing link instead.';
}

/** Opens the back camera. Throws an error named `Unsupported` where the page cannot ask (no HTTPS, an old browser). */
export async function openCamera(media: Pick<MediaDevices, 'getUserMedia'> | undefined = globalThis.navigator?.mediaDevices): Promise<MediaStream> {
  if (!media?.getUserMedia) throw Object.assign(new Error('getUserMedia unavailable'), { name: 'Unsupported' });
  return media.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
}

export function QrScanner({ stream, onResult, onClose }: { stream: MediaStream; onResult: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [hint, setHint] = useState('Point the camera at the code on your computer.');
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let stopped = false, frame = 0;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    element.srcObject = stream;
    void element.play().catch(() => setHint('Tap the picture to start the camera.'));
    const tick = () => {
      if (stopped) return;
      if (context && element.readyState >= element.HAVE_ENOUGH_DATA && element.videoWidth > 0) {
        const scale = Math.min(1, SCAN_SIZE / Math.max(element.videoWidth, element.videoHeight));
        const width = Math.round(element.videoWidth * scale), height = Math.round(element.videoHeight * scale);
        canvas.width = width; canvas.height = height;
        context.drawImage(element, 0, 0, width, height);
        const code = jsQR(context.getImageData(0, 0, width, height).data, width, height, { inversionAttempts: 'attemptBoth' });
        if (code?.data) { stopped = true; onResult(code.data); return; }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { stopped = true; cancelAnimationFrame(frame); element.srcObject = null; };
  }, [stream, onResult]);
  // Whatever closes the sheet stops the camera (the light goes off at once).
  useEffect(() => () => { for (const track of stream.getTracks()) track.stop(); }, [stream]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  return <div className="web-scan" role="dialog" aria-modal="true" aria-label="Scan pairing code">
    <video ref={video} className="web-scan-video" playsInline muted autoPlay onClick={() => void video.current?.play().catch(() => {})} />
    <div className="web-scan-frame" aria-hidden="true" />
    <p className="web-scan-hint">{hint}</p>
    <button type="button" className="web-secondary web-scan-close" onClick={onClose}>Cancel</button>
  </div>;
}
