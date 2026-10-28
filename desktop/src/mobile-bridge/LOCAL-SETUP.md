# Local mobile activation preparation

This procedure prepares the existing mobile bridge. It does not add a server, change approval
policy, issue credentials automatically, or activate the currently running app. `preflight.mjs`
uses Node built-ins only and performs no network requests/listens or file writes. Run it with
an absolute config filename; output contains check stages, never config contents or credentials.

## Prepare without starting Botling

For the coordinated Cloudflare Tunnel deployment, the public origin is
`https://botling-bridge.driseam.com`; the private backend is `https://127.0.0.1:8443` on the Mac.
The tunnel connector must run on this Mac because the cluster cannot route the home LAN.
Public origin port and local listener port are independent; neither endpoint may use HTTP.
Supply a certificate/key for the public hostname SAN with issuer trusted by the local connector.
Do not generate credentials before flux-k8s confirms the trust scheme. This procedure does not
create Cloudflare resources, change system trust, or install/start the connector.

Persistent opt-in is `<actual selected app profile>/core/mobile/config.json`. Determine the
selected profile from the running app/authorized launch contract; do not assume the Finder default
when `BOTLING_DATA_DIR` or `--botling-update-data` chooses another profile. From the repo root,
replace the placeholder with that verified profile before running these preparation commands:

```sh
mobile_private="/REPLACE/verified-app-profile/core/mobile"
(umask 077; mkdir "$mobile_private") &&
  (umask 077; cp -n desktop/src/mobile-bridge/config.example.json "$mobile_private/config.json")
# Stop on any failure; inspect an existing directory rather than overwriting it.
```

Replace every example value with the agreed private endpoint and absolute paths. On this macOS
installation the shell path for `assets` is "$HOME/Applications/Botling 2.app/Contents/Resources/mobile".
Expand `$HOME` to the actual absolute home-directory path before writing JSON: JSON does not
expand shell variables, and a literal `$HOME` value is invalid for this absolute-path field.
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

Preflight checks exact config fields, specific local private IPv4, HTTPS origin and independent valid listener port, key
permissions, certificate time/SAN and key pairing, client schema/current Main grant, and the five
nonempty assets. It does not verify certificate chain trust, phone DNS/firewall, free port, token
possession, or actual core behavior. A loopback PASS checks the local backend only; phone access additionally requires the local connector and edge route. Failures print only a
stage; inspect that local input without copying secrets into chat. Encrypted keys cannot work
with the current bridge configuration (there is no passphrase field).

## Separately authorized activation

There is no live configure command. At startup the core uses this precedence:

1. If `BOTLING_MOBILE_CONFIG` is present, use that explicit path. Empty means disabled. Invalid or
   missing explicit file fails closed, never falling back to a default. Existing env-path behavior
   is preserved; clear the override deliberately if switching to profile-local discovery.
2. Otherwise read only `<selected core data>/mobile/config.json`. Absent means disabled. The mobile
   directory must be owner-only 0700 and the config owner-only 0600; discovery rejects symlinked
   mobile directories/config files and malformed config. No other profile/home path is searched.
3. Probe cores skip all mobile config IO and never bind. Discovery does not mutate process.env,
   so an inherited discovered path cannot silently enable a different selected profile later.

Main already passes `<actual selected app profile>/core` as core data. No main startup/settings
change is needed. On a separately confirmed App-managed install/restart, the existing installer
preserves/selects the app profile and the new core discovers that profile's opt-in. The config
persists outside the bundle for future Finder starts selecting the same profile. A Finder start
selecting a DIFFERENT profile stays disabled unless that profile has its own opt-in or an explicit
override is supplied. Normal authorized profile migration carries the profile's private files;
this implementation does not copy them or choose another profile itself.

Creating the file does not reconfigure an already running core. Complete local preparation and
preflight, then request the existing App install/restart confirmation; do not launch a duplicate
app, kill the current core, or use a hot swap solely to bypass restart confirmation. No launchd,
launchctl, global environment or app-owned settings writes are part of this setup.

The connector must preserve public Host and browser Origin while verifying upstream TLS with
public hostname SNI and its trusted CA. `cloudflared` is not installed by these changes. A local
loopback listener is unreachable from the phone without the approved connector and edge routing.

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
allocated acceptance window: with no explicit environment override, verify the new core rediscovers
only the selected profile's private config; a different unconfigured profile stays disabled.
Probe must not bind; old core must release the port within the 15.75-second retry wait window,
new core must serve again, and uncertain mutations must not duplicate. These are runtime acceptance
checks, not established by the unit tests. Flux owns Tunnel/rate-limit configuration; Cloudflare Access is not used; app bearer
verification remains required.
On the physical phone check certificate trust, keyboard/composer layout, and Add to Home Screen.
Viewport screenshots and synthetic browser fixtures cannot establish these device behaviors.
Rich cards, attachments, offline chat, push delivery, and reload-persistent drafts are outside the
existing mobile feature contract; do not invent those features during this acceptance pass.

## Preparation verification status

The prior approved preflight passed ten offline cases on commit 78c9fb01. This revision changes
port separation and adds profile-local discovery; new focused bridge/discovery/listener cases and
an updated offline preflight pass must be recorded separately. No physical phone, production
config, real certificate, tunnel or App startup acceptance follows from unit/fixture results.
