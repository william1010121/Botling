import { resolve } from 'node:path';
import { packagedDataDir } from './main-environment';
import { openApp, type Fs } from './hot-install';
/** Pins the ordinary Finder launch destination; never changes signed package metadata. */
export interface InstallProfilePin { appDataDir: string; dataDir: string; devTrial: boolean }
export function validateProfilePin(pin: InstallProfilePin, dataDir = pin.dataDir): void {
  if (resolve(pin.appDataDir) !== pin.appDataDir || resolve(pin.dataDir) !== pin.dataDir
    || dataDir !== pin.dataDir || packagedDataDir(pin.appDataDir, pin.devTrial) !== pin.dataDir)
    throw new Error('Install profile pin must match the ordinary packaged launch profile');
}
export async function verifyProfilePin(app: string, pin: InstallProfilePin, fs: Fs): Promise<void> {
  validateProfilePin(pin);
  const source = await openApp(app, fs);
  const pkg = JSON.parse((await source.read('package.json')).toString('utf8'));
  if ((pkg.botlingDevTrial === true) !== pin.devTrial) throw new Error('Signed candidate profile differs from pinned profile');
}
