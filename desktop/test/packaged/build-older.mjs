// Disposable rollback fixture only. Same compiled code, an older package version, no release trust.
// Run after build.mjs; never publishes or installs. All caches and output stay beside the checkout.
import { build, Platform } from 'electron-builder';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../../electron-builder.config.cjs';
const desktop = join(dirname(fileURLToPath(import.meta.url)), '../..');
process.env.ELECTRON_BUILDER_CACHE ||= join(desktop,'.cache/electron-builder');
process.env.electron_config_cache ||= join(desktop,'.cache/electron');
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
config.directories.output = join(desktop,'.cache/update-old');
config.extraMetadata = {...config.extraMetadata,version:'2.0.0-dev',botlingUpdates:'unsigned-updates'};
Object.assign(config.mac,{identity:'-',hardenedRuntime:false,notarize:false,entitlements:undefined,entitlementsInherit:undefined});
await build({targets:Platform.MAC.createTarget('dir'),config,projectDir:desktop,publish:'never'});
