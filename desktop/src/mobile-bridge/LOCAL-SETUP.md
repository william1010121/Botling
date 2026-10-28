# Local mobile activation preparation

This procedure prepares the existing mobile bridge. It does not add a server, change approval
policy, issue credentials automatically, or activate the currently running app. `preflight.mjs`
uses Node built-ins only and performs no network requests/listens or file writes. Run it with
an absolute config filename; output contains check stages, never config contents or credentials.

## Prepare without starting Botling

Use an existing private LAN/VPN route. Supply the specific computer IPv4, private HTTPS hostname
and port, and the existing certificate chain/private key. The certificate SAN must match the
hostname. Phone DNS and trust of its issuing CA are separate requirements. Do not create a CA,
change system/device trust, set up forwarding, or expose a public service as part of this procedure.
The IP and hostname in `config.example.json` are examples, not detected or approved endpoints.

From the repository root, choose a NEW account-owned directory for this phone configuration:

```sh
mobile_private="$HOME/.botling-mobile-phone"
(umask 077; mkdir "$mobile_private")
# Stop if mkdir reports an existing directory; inspect/reuse it deliberately, do not overwrite.
(umask 077; cp -n desktop/src/mobile-bridge/config.example.json "$mobile_private/config.json")
chmod 600 "$mobile_private/config.json"
```

Replace every example value with the agreed private endpoint and absolute paths. On this macOS
installation `assets` is `/Users/guoshengwei/Applications/Botling 2.app/Contents/Resources/mobile`.
Do not change permissions of existing shared certificate files blindly: use an account-owned
private key with no group/world permissions. Config and client policy must also be owner-only.
Do not commit private files. The template contains no credential and cannot activate a service.

The current frontend first requests Main, so the phone client MUST include Main ID
`6A0B0000-0000-4000-8000-000000000002`; additional project bot grants require an explicit scope.
Main-only is the smallest usable grant. Once the endpoint and intended phone are chosen, the
existing local setup tool can issue a 30-day token without printing it:

```sh
node desktop/src/mobile-bridge/setup.mjs issue "$mobile_private/clients.json" phone "$mobile_private/phone-token.txt" 6A0B0000-0000-4000-8000-000000000002
node desktop/src/mobile-bridge/preflight.mjs "$mobile_private/config.json"
```

Set `clientsFile` to that policy path before preflight. Keep the client ID stable across renewal
and keep the core `mobile-mutations` journal; never delete it to clear an uncertain send. Existing
setup refuses duplicate client IDs and existing token-output filenames. For renewal, revoke first
and choose a new private token-output file; do not silently overwrite or discard credentials.
Transfer the token to the intended phone privately; never use URLs, shell arguments, screenshots,
shared logs, or this repository. This preparation run has NOT issued a live token.

Preflight checks exact config fields, specific local private IPv4, HTTPS/port agreement, key
permissions, certificate time/SAN and key pairing, client schema/current Main grant, and the five
nonempty assets. It does not verify certificate chain trust, phone DNS/firewall, free port, token
possession, or actual core behavior. A loopback PASS is computer-local only. Failures print only a
stage; inspect that local input without copying secrets into chat. Encrypted keys cannot work
with the current bridge configuration (there is no passphrase field).

## Separately authorized activation

Current core has no live configure command: `startConfiguredMobile` reads `BOTLING_MOBILE_CONFIG`
once at startup; probe cores intentionally skip it. Exporting a variable in a new shell cannot
modify the running core. Do NOT launch a second app against the same profile, kill/restart the
current core, or hot-swap it merely to activate mobile during other workers' jobs.

At a coordinator-approved restart window, after clean app exit and successful preflight, launch
the existing installed executable with its existing operational profile environment preserved.
For the standard installed path, the additional environment setting is:

```sh
BOTLING_MOBILE_CONFIG="$mobile_private/config.json" "$HOME/Applications/Botling 2.app/Contents/MacOS/Botling 2"
```

This command is documentation only and was NOT executed. If the normal launcher supplies data
or profile overrides, preserve those verified values; do not switch profiles by copying this
command blindly. The variable is process-local, not persistent for future Finder launches.
An approved persistent launcher arrangement must retain it on later app starts. No launch agent,
launchctl environment mutation, app install, or profile write is included here.

## Device and bridge acceptance

Open the exact origin plus `/mobile/` (trailing slash required), enter the private token, and check
Main and any explicitly granted project. Use a harmless test conversation/question. Verify send
and polling, per-chat drafts/reply-to/engine choice, question choice/free text, tasks, hidden/offline
poll pause/resume, and loss-of-response uncertainty. Verify desktop unread is unaffected and queued
files block mobile sending. Do not approve a real install or tool solely to test the approval UI.
Approval classes permissionTool/denialAsks/appQuestions are user-authorized through existing checks.

Verify revocation with the local tool, then verify the phone's next request is refused:

```sh
node desktop/src/mobile-bridge/setup.mjs revoke "$mobile_private/clients.json" phone
```

Revocation does not cancel a command already dispatched. Test live core handover only in its
allocated acceptance window: probe must not bind; old core must release the port within the
15.75-second retry wait window, new core must serve again, and uncertain mutations must not duplicate.
On the physical phone check certificate trust, keyboard/composer layout, and Add to Home Screen.
Viewport screenshots and synthetic browser fixtures cannot establish these device behaviors.
Rich cards, attachments, offline chat, push delivery, and reload-persistent drafts are outside the
existing mobile feature contract; do not invent those features during this acceptance pass.

## Preparation verification status

This addition is local preparation, not mobile acceptance. On 2026-10-28 the allocated
offline behavior check passed all 10/10 disposable certificate/config cases in 0.73 seconds:
valid input, wrong SAN, wrong key, expired certificate, public bind address, missing bind
address, unsafe permissions, expired Main grant, missing Main grant, and missing assets.
Syntax/JSON/diff static checks also passed. These results are reused for this cumulative
candidate; they do not validate a real endpoint, certificate/config, or physical phone.
No listener, app launch, live token issuance, or production profile change was required.
Phone DNS/TLS trust, device behavior, and live bridge/core acceptance remain unverified.
