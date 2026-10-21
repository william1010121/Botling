# Telegram mobile chat (opt-in preview)

This is a text-only channel into the **same running Mac app, bots, project folders and sessions**.
It does not run Claude or Codex on the phone, create another agent, or expose a listening port.
The Mac must be awake, online, and running ClaudeCodeBot. Closing the app stops the bridge.

## Before enabling

This feature is disabled unless all three environment values below are supplied to the app process.
This PR does **not** create a Telegram bot, request a token, enable remote access, or change any
credentials. Create/configure your bot yourself only after reviewing this feature.

Telegram receives the text you send and the replies relayed back. A phone message can ask the local
agent to perform real work, under that bot's **existing** tool permissions, always-allowed rules and
auto mode. Text-only does not mean read-only. Use a dedicated restricted bot if that is what you want.
The bridge never clicks approval buttons, changes permission rules, or makes a raw shell/file API
available. Pending decisions must be resolved in the Mac app.

Use a dedicated Telegram bot with no webhook and no other polling client. This app does not delete
webhooks or take over another integration. Only one ClaudeCodeBot process may poll the bot.

## User-controlled setup

Supply these variables to the actual app process when launching its executable from a terminal:

- CCB_TELEGRAM_ENABLED: exactly 1
- CCB_TELEGRAM_OWNER_ID: your verified numeric Telegram user ID
- CCB_TELEGRAM_CHAT_ID: the verified positive ID of your private chat with this bot

Create a generic password yourself in macOS Keychain Access: service/name **ClaudeCodeBot Telegram**,
account **bot-token**, password your bot token. The bridge only reads this existing item once at
startup and never creates or changes it or its access controls. Lookup is noninteractive: if access
is not already allowed, the channel stays disabled; grant access yourself before retrying.

Do not put a token in source, a PR, screenshots, command history, or chat with an assistant. The token must NOT be supplied through an environment variable. Remove any
CCB_TELEGRAM_TOKEN left by a preview setup; the bridge rejects that setup. The bridge never writes
the Keychain token to its checkpoint, child-process environment or API error logs/URLs. Keychain
avoids automatic credential inheritance; it is not a sandbox against arbitrary same-user shell
commands or software already authorized to read that Keychain item. Finder launches do not automatically inherit
your terminal environment. Remove the variables and restart to disable.

The sender ID AND private chat ID must match. Groups, channels, forwarded/via-bot messages and
messages older than ten minutes are ignored. Display names and usernames are never authorization.

On first activation the pre-existing Telegram backlog is discarded. Send a fresh /start afterward.
If the bot or owner changes, disable the bridge and deliberately remove the old
~/.claudecodebot/telegram-state.json checkpoint before re-enabling; mismatched or corrupt state
fails closed.

## Phone commands

- /start or /help: usage
- /bots: list main, Codex and project/bot IDs
- /use main, /use codex, or /use <project ID>: select the target without changing the desktop selection
- /status: working/idle/waiting for approval
- /latest: latest text reply from the selected bot
- /stop: request interruption of that bot's current foreground turn. Background tasks and other
  bots keep running. Tidy/handoff/group turns and pending decisions must be managed on the Mac.
- Other text: send through Workspace.send, including existing plugin beforeSend handling

Unknown slash commands are rejected, not forwarded into app/plugin commands. When any decision
card is pending in the selected bot, normal text is blocked until it is settled on the Mac.
There are intentionally no remote permission/decision buttons in this first version.

After sending text to a bot, new bot/notice/error messages in that chat are relayed while the bridge
runs, including replies to work continued on the desktop. Up to 16 chats may be watched per run.
Restarting does not replay old replies; /latest recovers the newest answer. A selected project ID
survives restart; watch subscriptions do not.

## Reliability and resource limits

- Outbound-only HTTPS long polling; no tunnel, port forwarding, server, deployment or new service.
- Updates are checkpointed atomically **before** dispatch. Duplicate updates are skipped.
  This is at-most-once dispatch, not exactly-once delivery: a crash after checkpoint but before
  dispatch can lose a request. Inspect the desktop and resend intentionally if needed.
- Outgoing sends are not retried after an uncertain response; /latest recovers missing reply text.
- 20 updates per poll, five-second long poll, 1 MiB maximum API response, 16 KiB input text,
  32 queued output messages, at most three sends per poll spaced one second apart.
  Bursts beyond the queue limit are dropped. Long replies are truncated below Telegram's limit.
- The checkpoint is one small replaced file, not an accumulating message log.
- Checkpoint writes fail closed below 512 MiB free disk. No incoming command is dispatched if its
  checkpoint cannot be saved. No media is downloaded and no disk/network caches are introduced.
- Network errors pause/retry with delay and show a generic Mac notice. Credentials are not included.
  HTTP redirects are refused because Telegram's token is part of the request URL.

## Not in this preview

Images/uploads, voice, group chats/topics, streaming drafts, remote approval cards, artifact file
downloads, components, phone push configuration and a native iOS app. Telegram supports more than
this; these are deliberate implementation limits, not claims about Telegram's capabilities.

A future mobile web UI can use the same Workspace/Bot APIs without changing the agent backend.
This channel does not assume that the target runs Claude; the existing read-only Codex reviewer
retains its own capabilities and restrictions.

## Validation and disk-safe development

Tests use FakeTelegram and FakeLauncher only. They must not use real bot tokens or send messages.
Run swift test --filter TelegramTests and then the full existing CI checks on a Mac with Swift 6.2.
The repository's existing pull-request CI performs the full web typecheck/tests/build and Swift tests.

Before any local build, check free space. Do not start below 5 GiB; use a single checkout/build at a
time, monitor free space and stop if it falls below 2 GiB. Never delete user files to make room.
Do not commit .build, node_modules or copied build caches. Remote connector authoring of this PR
does not create a local clone or build cache.
