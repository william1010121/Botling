// The home-screen icon: iOS takes the 180px apple-touch-icon, paints any transparency black and rounds the corners itself,
// so that one is an opaque full square; Android masks a maskable icon (circle, squircle…), so it is opaque too, listed
// apart from the plain 192/512 ones. All are made from the desktop app's icon (Assets/AppIcon.png).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(__dirname);
/** Width, height and whether the PNG has an alpha channel (IHDR colour type 4 or 6). */
function png(name: string) {
  const bytes = readFileSync(join(dir, name));
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), alpha: bytes[25] === 4 || bytes[25] === 6 };
}

describe('phone icons', () => {
  it('the manifest lists 192 and 512 icons and a separate maskable 512, each the size it says', () => {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.webmanifest'), 'utf8')) as { name: string; short_name: string; icons: { src: string; sizes: string; purpose: string }[] };
    expect(manifest.short_name).toBe('Botling');
    const icons = manifest.icons.map(icon => ({ ...icon, file: png(icon.src.replace('./', '')) }));
    expect(icons.map(icon => `${icon.sizes} ${icon.purpose}`)).toEqual(['192x192 any', '512x512 any', '512x512 maskable']);
    for (const icon of icons) expect(`${icon.file.width}x${icon.file.height}`).toBe(icon.sizes);
    expect(icons.find(icon => icon.purpose === 'maskable')!.file.alpha).toBe(false);
  });

  it('the page links a 180px apple-touch-icon with no transparency, and a PNG favicon', () => {
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    expect(html).toContain('<link rel="apple-touch-icon" sizes="180x180" href="./icon-180.png">');
    expect(html).toContain('<link rel="icon" type="image/png" sizes="192x192" href="./icon-192.png">');
    expect(png('icon-180.png')).toEqual({ width: 180, height: 180, alpha: false });
  });
});
