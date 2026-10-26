System load card, written with the component kit (`<meta name="ccb-kit" content="1">`): CPU as a gauge, memory and load, each core, the last hour and the busiest processes. The bot supplies the data. Show it with `<show name="system-load">JSON</show>`.
Sizes: 1x1, 2x1, 2x2, 4x2
Icon: cpu

An example to copy (Web/kit/examples/system-load in the app's source). It has no command; give it one (`Command: …` printing this JSON) to make it live. "Ask why" answers the bot with a question about the busiest process (`ccb.answer(text)`).

## Data format (window.ccb.data)

All fields are optional; without `cpu` the card says there is no reading yet.

```json
{
  "host": "studio-mac",
  "updated": "10:42",
  "cpu": 72,
  "memory": { "used": 21.4, "total": 32 },
  "load": 6.8,
  "loadDelta": 1.2,
  "cores": [64, 81, 40, 92, 33, 58, 71, 22],
  "history": [31, 35, 48, 52, 47, 60, 66, 58, 72],
  "processes": [
    { "name": "node", "cpu": 88.4, "note": "vitest workers" },
    { "name": "WindowServer", "cpu": 21.3, "note": "screen compositing" }
  ]
}
```

- `cpu` (number, 0–100): the gauge; green under 60, amber under 85, red from 85 (`toneFor`).
- `memory.used` / `memory.total` (GB): coloured by how full it is.
- `load` (number) and `loadDelta` (its change; a rise is shown red).
- `cores` (numbers, 0–100 each): one column per core, coloured like `cpu`.
- `history` (numbers): CPU over time, oldest first, as a sparkline.
- `processes` ({name, cpu, note}): the first three, in the order given.

## Display rules

- 1×1: only the gauge and the host name. 2×1: gauge, memory and load. 2×2 and larger: also the cores, the history, the processes and "Ask why".
- Pinned, its chip shows "CPU 72%" in the gauge's tone; no `cpu` clears it.
