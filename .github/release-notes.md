## What's new in 1.18.0

- Claude and Codex can work as two heads of the same bot, hand work to each other, and run
  independent app-managed Codex workers while you keep chatting.
- A unified input dock brings pinned components, Answer with and a panel for multiple
  hand-offs together. Native-style settings include engine, model, effort and worker options.
- Cute character avatars animate and have a saved 32–96 px chat size. Emoji reactions,
  work status and read heads share the message footer.
- Web chats gain Grok, multiple Google accounts for Gemini and pinned conversations.
  Switching provider or account keeps its selected conversation; Gemini submenu positioning
  and cross-bot reply identities are corrected.
- App context savings send reaction and component changes after the initial snapshot.
  Separate saved switches in Settings → Usage apply to both engines.
- Interrupted replies keep their partial text and steps, and Claude subagent token speed
  uses the final output count.

See the [full changelog](https://github.com/william1010121/Botling/blob/v1.18.0/CHANGELOG.md#1180).

## Known limitations

- **Stop all** stops all in-flight hand-offs together; individual row stopping is not available.
- Authenticated Grok replies and sign-in persistence, a second Google account, Gemini's
  nested menu on the real site, live model reactions and interruption recovery still need
  live acceptance. Local fixtures and startup checks do not establish those results.

**Install**

1. On macOS 14 or later (Apple silicon or Intel), download `botling-1.18.0-macOS.zip` below,
   unzip it, and replace the previous app in Applications with **Botling.app**.
2. The app is not notarized: the first time, right-click it → **Open** → **Open**.
3. Install and sign in to the CLI for the head you use: [Claude Code](https://docs.claude.com/en/docs/claude-code)
   (`claude` on your PATH) or Codex (`codex` on your PATH). Node.js (for plugin programs)
   and git (for the plugin library) are recommended.

Existing chats, settings, plugin secrets and web profiles reuse their current storage and
application identity. Keep one installed copy when replacing the app.

See the [README](https://github.com/william1010121/Botling#readme) for what it does and how it works.
