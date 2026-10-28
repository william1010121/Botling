import type { FlowWorker } from "../../../src/renderer/token-flow-model";
export const records = [
  ['backlog', 'Task 堆積原因', 'execution', 4100000],
  ['agy', 'agy 合併', 'execution', 1900000],
  ['release', 'Task 修正整合與打包', 'execution', 1700000],
  ['chat', 'Chat', 'unknown', 1500000], ['chat', 'Chat', 'communication', 200000],
  ['other', 'Other work', 'execution', 400000], ['other', 'Other work', 'unknown', 1200000],
  ['other', 'Other work', 'communication', 400100],
].map(([id, title, purpose, output], index) => ({ key: `record:${index}`, tasks: [{ id, name: title }], purpose, output, attributableOutput: output, startedAt: 0, endedAt: null })) as FlowWorker[];
