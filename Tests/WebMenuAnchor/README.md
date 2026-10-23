# Gemini nested menu anchoring

Run `python3 Tests/WebMenuAnchor/run.py /private/tmp/web-menu-anchor-checks` on macOS.
This compiles production `WebMenuAnchoring` and `WebLaas` directly and runs three isolated
WKWebView processes, each using a fresh nonpersistent website store. No installed App,
real profile, login, chat, upload or remote page is used. The first process must fail the
placement assertion; the repaired suites must pass. SwiftPM is not required for this probe.

The local fixture is a de-identified reduction of the authenticated Gemini model menu
observed on 2026-10-23: `gem-menu`, `aria-controls`, nested manual CDK popovers, overflow
wrapper and translated panes. It supplies **valid dynamic coordinates**, rather than
hard-coding the observed wrong origin. On tested macOS 26.3 WKWebView the nested top-layer
render box remains at the origin despite the valid authored/computed inset; the same
fixture at 912x680 positions correctly in Chromium 154. The fixture's layout sizes describe
sample UI; production positioning derives from the semantic trigger, measured menu and viewport.

Checks include window resize, native pageZoom, CSS zoom, RTL, viewport edge flipping/clamping,
scrolling, a third nested portal, style and DOM restoration, reopen, focus, actual-node
listeners, document delegation, synthetic site Escape close/parent/style/focus restoration,
no self-sustaining style mutation loop, normal placement no-op and host isolation.
The synthetic Escape handler models document-level site ownership; ancestor-only event
delegation and inherited ancestor styling can still change while a portal is moved and
require authenticated live acceptance. It is not a native keypress or installed-App check.
The third process also installs the production network tap and web-laas scripts/settings shim.
Snapshots/JSON describe a local fixture, not an authenticated installed-App acceptance test.
