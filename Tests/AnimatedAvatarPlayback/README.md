# Animated avatar playback probe

Synthetic data only; never opens live chats, signs in, installs, or restarts Botling.
Run from the isolated checkout after building `Web/` with its existing dependencies:

```sh
python3 Tests/AnimatedAvatarPlayback/fixture.py "$PWD" /private/tmp/avatar-evidence
swiftc -parse-as-library Tests/AnimatedAvatarPlayback/probe.swift -o /private/tmp/avatar-probe
/private/tmp/avatar-probe "$PWD" /private/tmp/avatar-evidence 640
/private/tmp/avatar-probe "$PWD" /private/tmp/avatar-evidence 360
/private/tmp/avatar-probe "$PWD" /private/tmp/avatar-evidence 320
```

The probe loads the actual generated chat bundle and original GIFs in WKWebView.
Its window is invisible and offscreen; `document.visibilityState` is explicitly
simulated as visible **in the fixture only** so the application visibility guard
allows playback without displaying or focusing a window. This is a synthetic
WebKit test, not an installed-app or real-model acceptance test.

For each width, it captures eight crops of the avatar only, excluding the typing
dots. It requires more than one pixel hash with CSS animation/transform both
`none`, verifies 12 selectable library sources, saves chat/library screenshots,
and requires zero GIF sources after `ccb.setWindowVisible(false)`. JSON results
record the synthetic visibility override and all frame hashes.

The Core tests decode all 12 bundled GIFs using ImageIO, compare frame pixels and
GIF timing with the catalog, and check Original/group payload isolation. The Web
suite covers stream-node stability, completion/wait/failure/interruption states,
100 historical avatars, occlusion/offscreen/reduced motion, failed GIF loading,
the 12-clip library, and unchanged text emoji reactions.

The integration fixture uses a 96px avatar with the existing footer, completed tasks,
reactions and read receipts. Each width verifies 32/48/96px patches retain the same
avatar/row nodes and do not overflow, expands footer tasks and the reaction picker,
and confirms the reaction bridge action. All twelve GIFs must load individually.
It simulates a reduced-motion media query change (recorded in JSON), requires zero
GIF sources, then simulates a GIF error and checks the visible, decoded static
fallback. Finally it checks the Original image renderer. This does not change
system accessibility preferences. Screenshots contain synthetic data only.
