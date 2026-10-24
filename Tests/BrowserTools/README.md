# General browser workflow fixture

This fixture compiles the actual app sources with a synthetic preview entry point. It uses only a loopback HTTP server, a valid local Node plugin, a temporary workspace, and new persistent WebKit account identifiers. The synthetic Maintainer launcher deliberately cannot run a model. No installed app, real account, shared workspace data, or site-specific production plugin is changed.

Run from the isolated worktree:

```sh
swift test --filter 'BrowserShelfTests|WebCaptureTests|PluginHostTests'
python3 Tests/BrowserTools/run.py /absolute/path/to/evidence
```

The harness requires macOS AppKit/WebKit process access and a Node executable. It writes assertion arrays (`checks.json`, `restore-checks.json`), actual production RootView screenshots at 1280 and 980 points, and its isolated fixture data. It verifies manual sign-in persistence across reload and a second native process, isolated accounts, current-page Capture artifacts and network traffic, the saved website request and Maintainer relay, the real Node-to-App browser bridge, exact origin/account/tab guards, read-only defaults, stale-target rejection, and navigation/back behavior.

The bridge contract is `ccb.browser.registerTool({id,title,origin}, async scope => result)` and `ccb.browser.perform({...scope,operation:'observe'|'click'|'extract',target?})`. Only targets returned by the latest observation can be used; selectors and arbitrary JavaScript are not bridge inputs. Clicks require the user's website/account opt-in and an active tool invocation. Existing conversation extractors remain read-only. Site-specific plugin logic stays in the Maintainer-managed library.

These checks establish the native workflow with synthetic content. They do not establish real-provider OAuth compatibility, a live-model plugin authoring roundtrip, external website pagination, or acceptance in an installed/released package.
