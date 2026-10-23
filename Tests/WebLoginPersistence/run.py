#!/usr/bin/env python3
"""Native WebKit process/replacement/rebrand regression. No real website/store is opened."""
import argparse
import http.server
import re
import json
import pathlib
import plistlib
import shutil
import subprocess
import tempfile
import threading
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
PAGE = b'''<!doctype html><meta charset="utf-8"><script>
window.check = async phase => {
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open('synthetic-login', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('state');
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  const read = () => new Promise((resolve, reject) => {
    const t = db.transaction('state'); const r = t.objectStore('state').get('signed-in');
    r.onsuccess = () => resolve(r.result === true); r.onerror = () => reject(r.error);
  });
  if (phase === 'seed') {
    await fetch('/login');
    localStorage.setItem('signed-in', 'yes');
    sessionStorage.setItem('transient', 'yes');
    await new Promise((resolve, reject) => {
      const t = db.transaction('state', 'readwrite'); t.objectStore('state').put(true, 'signed-in');
      t.oncomplete = resolve; t.onerror = () => reject(t.error);
    });
  }
  const authenticated = (await fetch('/authenticated')).status === 204;
  const flags = {httpOnlyPersistentCookie: authenticated,
    localStorage: localStorage.getItem('signed-in') === 'yes', indexedDB: await read(),
    processBoundary: phase === 'seed' || sessionStorage.getItem('transient') === null};
  db.close(); return flags;
};
</script>'''

class FixtureServer(http.server.ThreadingHTTPServer):
    def handle_error(self, request, address):
        # A WebKit process exiting can reset an idle HTTP connection.
        import sys
        if not isinstance(sys.exception(), ConnectionResetError):
            super().handle_error(request, address)


class Site(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == '/login':
            self.send_response(204)
            self.send_header('Set-Cookie', 'synthetic-login=fixture-only; HttpOnly; Max-Age=3600; SameSite=Lax; Path=/')
        elif self.path == '/authenticated':
            self.send_response(204 if 'synthetic-login=fixture-only' in self.headers.get('Cookie', '') else 401)
        else: self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        if self.path == '/': self.wfile.write(PAGE)


def source_contract(root, rebrand=False):
    sites = (root / 'Sources/ClaudeCodeBotCore/WebSites.swift').read_text()
    pinned = re.findall(r'dataStoreID: UUID\(uuidString: "([A-F0-9-]+)"\)', sites)
    assert pinned == ['3E3B0000-0000-4000-8000-0000000000D1',
                      '3E3B0000-0000-4000-8000-0000000000D2',
                      '3E3B0000-0000-4000-8000-0000000000D3',
                      '3E3B0000-0000-4000-8000-0000000000D4'], 'Published profile UUIDs changed'
    web = (root / 'Sources/ClaudeCodeBot/WebSiteViews.swift').read_text()
    # Each page opens its account's store; the first account is the site's own published store.
    assert 'configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: account.dataStoreID)' in web
    assert 'let account = account ?? WebAccount.first(of: site)' in web
    accounts = (root / 'Sources/ClaudeCodeBotCore/WebAccounts.swift').read_text()
    assert 'WebAccount(id: firstID, color: 0, dataStoreID: site.dataStoreID)' in accounts
    assert 'guard id != WebAccount.firstID' in accounts
    assert '.nonPersistent()' not in web
    assert 'removeData' not in web and 'deleteCookie' not in web
    # The only store removal: an added account's, never the first account's or a built-in site's.
    assert web.count('WKWebsiteDataStore.remove(forIdentifier:') == 1
    assert 'guard !account.isFirst, WebAccountList.isRemovableStore(account.dataStoreID) else { return }' in web
    assert '_ = WKWebsiteDataStore.default()' in web  # WebKit's run loop before a removal
    packaging = (root / 'scripts/make-app.sh').read_text()
    assert '<key>CFBundleIdentifier</key><string>io.github.william1010121.ClaudeCodeBot</string>' in packaging
    assert 'codesign --force --deep --sign - "$APP"' in packaging
    assert 'app-sandbox' not in packaging  # Sandbox/container changes need a new compatibility audit.
    if rebrand:
        assert '<key>CFBundleExecutable</key><string>botling</string>' in packaging
        assert 'APP="dist/Botling.app"' in packaging
    secrets = (root / 'Sources/ClaudeCodeBotCore/Secrets.swift').read_text()
    assert r'"ClaudeCodeBot plugin \(plugin)"' in secrets
    print('PASS: source compatibility contract' + (' (Botling)' if rebrand else ''), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rebrand-root', type=pathlib.Path, help='Also audit the pending Botling checkout')
    parser.add_argument('--source-only', action='store_true')
    options = parser.parse_args()
    source_contract(ROOT)
    if options.rebrand_root: source_contract(options.rebrand_root, rebrand=True)
    if options.source_only: return
    server = FixtureServer(('127.0.0.1', 0), Site)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    identity = 'io.botling.session-probe.' + uuid.uuid4().hex
    store = str(uuid.uuid4())
    other_store = str(uuid.uuid4())
    with tempfile.TemporaryDirectory(prefix='web-login-persistence-') as temp:
        temp = pathlib.Path(temp)
        binary = temp / 'probe'
        subprocess.run(['swiftc', '-parse-as-library', '-j', '2', str(ROOT / 'Tests/WebLoginPersistence/Probe.swift'), '-o', str(binary)], check=True)
        for name, executable, version, phase, profile in [
            ('ClaudeCodeBot', 'ClaudeCodeBot', '1', 'seed', store),
            ('ClaudeCodeBot', 'ClaudeCodeBot', '2', 'verify', store),
            ('Botling', 'botling', '3', 'verify', store),
            ('Botling', 'botling', '3', 'empty', other_store),
            ('Botling', 'botling', '3', 'verify', store),
            # A second account on its own store, signed in beside the first.
            ('Botling', 'botling', '3', 'seed', other_store),
            ('Botling', 'botling', '3', 'verify', store),
            # That account removed: its store goes; the first account's sign-in stays.
            ('Botling', 'botling', '3', 'remove', other_store),
            ('Botling', 'botling', '3', 'verify', store),
            ('Botling', 'botling', '3', 'empty', other_store),
        ]:
            app = temp / (name + '.app')
            if app.exists(): shutil.rmtree(app)  # replaces only this synthetic app bundle
            macos = app / 'Contents/MacOS'
            macos.mkdir(parents=True)
            shutil.copy2(binary, macos / executable)
            info = dict(CFBundleIdentifier=identity, CFBundleName=name, CFBundleDisplayName=name,
                        CFBundleExecutable=executable, CFBundlePackageType='APPL', CFBundleVersion=version)
            (app / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
            subprocess.run(['codesign', '--force', '--deep', '--sign', '-', str(app)], check=True, capture_output=True)
            process = subprocess.run([str(macos / executable), f'http://127.0.0.1:{server.server_port}/', profile, phase],
                                     capture_output=True, text=True, timeout=40)
            flags = json.loads(process.stdout) if process.stdout.strip().startswith('{') else {}
            result = dict(name=name, executable=executable, version=version, phase=phase, exit=process.returncode, checks=flags)
            print(json.dumps(result), flush=True)
            if phase == 'remove':
                removed_dir = pathlib.Path.home() / 'Library/WebKit' / identity / 'WebsiteDataStore' / profile
                if process.returncode or flags != {'removed': True} or removed_dir.exists():
                    raise SystemExit('FAIL: removing an added account store')
                print(json.dumps(dict(removedProfileDirectoryGone=True)), flush=True)
                continue
            if process.returncode or len(flags) != 4:
                raise SystemExit('FAIL: synthetic persistence boundary')
        # Inspect paths only inside this random test identity. Never inspect any live store.
        webkit = pathlib.Path.home() / 'Library/WebKit' / identity
        directories = [webkit / 'WebsiteDataStore' / profile for profile in [store, other_store]]
        on_disk = all(directory.is_dir() for directory in directories)
        print(json.dumps(dict(testProfileDirectory='~/Library/WebKit/<random-test-bundle-id>/WebsiteDataStore/<random-profile-uuid>',
                              bothSyntheticProfilesOnDisk=on_disk)), flush=True)
        if not on_disk: raise SystemExit('FAIL: synthetic profiles were not persisted on disk')
    server.shutdown()
    print('PASS: seed, replaced bundle upgrade, renamed bundle/executable, second account store removed; separate native processes')

if __name__ == '__main__': main()
