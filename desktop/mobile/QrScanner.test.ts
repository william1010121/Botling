import { describe, expect, it, vi } from 'vitest';
import { cameraError, openCamera } from './QrScanner';

describe('camera for the pairing scan', () => {
  it('asks for the back camera only, no microphone', async () => {
    const getUserMedia = vi.fn(async () => ({}) as MediaStream);
    await openCamera({ getUserMedia });
    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false, video: expect.objectContaining({ facingMode: { ideal: 'environment' } }) }));
  });
  it('where the page cannot ask (no HTTPS, an old browser) it says so instead of failing silently', async () => {
    await expect(openCamera({} as MediaDevices)).rejects.toMatchObject({ name: 'Unsupported' });
    expect(cameraError(Object.assign(new Error(), { name: 'Unsupported' }))).toContain('Paste the pairing link');
  });
  it('explains each refusal and always points at pasting the link', () => {
    expect(cameraError({ name: 'NotAllowedError' })).toContain('Allow it in Settings');
    expect(cameraError({ name: 'NotFoundError' })).toContain('No camera');
    expect(cameraError({ name: 'NotReadableError' })).toContain('in use');
    for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'Other']) expect(cameraError({ name }).toLowerCase()).toContain('paste');
    expect(cameraError(null)).toContain('could not start');
  });
});
