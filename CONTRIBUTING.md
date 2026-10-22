# Contributing to ClaudeCodeBot

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Report a bug or ask for a feature

Open an [issue](https://github.com/william1010121/ClaudeCodeBot/issues/new/choose) with the
bug or feature template. For a bug, include the app version, your macOS version and what
**Settings → Doctor** shows for Claude Code and Codex. Leave out chats, paths and anything else
personal.

## Set up

```bash
git clone https://github.com/william1010121/ClaudeCodeBot.git
cd ClaudeCodeBot
swift run ClaudeCodeBot      # Swift 6.2 (Xcode 26), macOS 14+
cd Web && npm ci             # only when you change the chat surface or plugins
```

The easiest way to work on the app is from the app: turn on **Settings → Developer mode** and
pick your checkout as its project. Its manager can then build and install a new version for you
(after you confirm; a build that does not come up within 90 seconds is rolled back), look at the
app's window, and gets every reply you mark "Not right".

## Pull requests

1. Branch from `main` and keep each PR to one change.
2. If you change `Web/`, rebuild it (`cd Web && npm run build`) and commit the output in
   `Sources/ClaudeCodeBot/Resources`; CI checks that it is up to date.
3. Run the checks CI runs:
   ```bash
   (cd Web && npm run typecheck && npm test && npm run build)
   swift build --build-tests && swift test
   ```
4. Add a line to [CHANGELOG.md](CHANGELOG.md) (under Added, Changed or Fixed) saying what changes
   for someone using the app. Leave `VERSION` alone; releases bump it.
5. For a visible change, attach a screenshot. The snapshot mode draws one with sample data, for
   example `CCB_SNAPSHOT=/tmp/chat.png swift run ClaudeCodeBot`.

By contributing you agree that your work is released under the
[GNU General Public License v3.0 or later](LICENSE).
