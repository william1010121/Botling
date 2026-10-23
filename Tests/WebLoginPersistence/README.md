# Native Web login persistence regression

Run on macOS with a GUI login session, WebKit, Swift compiler, Python 3 and codesign:

```sh
python3 Tests/WebLoginPersistence/run.py
# Also check the pending rename checkout's persistent identities/packaging:
python3 Tests/WebLoginPersistence/run.py --rebrand-root /path/to/botling-rename
# No native processes or HTTP listener:
python3 Tests/WebLoginPersistence/run.py --source-only
```

The script compiles a standalone AppKit/WKWebView harness with two compiler jobs.
A loopback-only fixture supplies an HttpOnly persistent cookie, localStorage and
IndexedDB login markers. Only authentication/storage booleans leave the fixture;
no user website, cookie, password, token or keychain item is read.

Five sequential native process launches test:

1. Seed an isolated profile with the legacy display/executable names.
2. Replace the synthetic app bundle and version, re-sign, relaunch: login survives.
3. Change bundle directory/display name to Botling and executable to botling,
   keep the bundle identifier and profile UUID, re-sign, relaunch: login survives.
4. Use another random profile at the same origin: all three login checks are false.
5. Reopen the original profile: all three checks remain true.

Each app process exits before the next launch. sessionStorage must be absent on
relaunch, providing a control against accidentally testing only same-page memory.
Both synthetic profile directories must exist on disk. The harness uses the same
public persistent-store configuration as WebTab; a source contract pins that call,
the three production profile UUIDs, legacy bundle ID, and plugin keychain service.
It does not instantiate the full production WebTab or run the actual updater.

Only temporary synthetic app bundles are replaced/deleted. Synthetic WebKit stores
remain in `~/Library/WebKit/io.botling.session-probe.<random>/WebsiteDataStore/`.
There is deliberately no website-store removal or migration operation. Random test
bundle identities and UUIDs isolate them from production; the harness also refuses
all three production UUIDs. No app is installed or registered with LaunchServices,
and the running application is never restarted.

Preserve the published UUIDs and legacy bundle ID across releases. Display/app/
executable names can change under the tested current ad-hoc signing configuration.
Changing sandbox entitlements, signing distribution/team or bundle ID needs a new
compatibility audit; do not infer keychain ACL behavior from this WebKit test.
Site expiry/revocation, session-only cookies and provider reauthentication policy
remain under site control. This test covers app-induced loss on normal relaunch,
bundle replacement and rebrand, not an unconditional promise of perpetual login.
