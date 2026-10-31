// Tests run inside whatever shell started them; when that is a Botling terminal, BOTLING_* points at the
// user's REAL data (BOTLING_DATA_DIR, BOTLING_IMPORT_FROM=~/.claudecodebot, ...). A core spawned from a
// test would import the real 1.x bots and its tidy would write their real .bot/memory.md. Every test
// process starts from a clean app environment; BOTLING_LIVE_* switches stay.
// Git variables (GIT_EDITOR=true in agent shells, GIT_DIR, ...) change what git does and trip the app's own git-safety checks.
for (const key of Object.keys(process.env)) if ((key.startsWith("BOTLING_") && !key.startsWith("BOTLING_LIVE_")) || key.startsWith("GIT_")) delete process.env[key];
