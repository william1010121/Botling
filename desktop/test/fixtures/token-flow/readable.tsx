import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TokenFlowCanvas } from '../../../src/renderer/TokenFlowCanvas';
import { historicalAllocation } from '../../../src/renderer/token-flow-history-model';
import type { BotView } from '../../../src/contract';
import { records } from './readable-data';
import '../../../src/renderer/styles.css';
import '../../../src/renderer/token-flow.css';
const allocation = historicalAllocation(records, 'all', Date.now());
function Fixture() {
  const [selected, onSelect] = useState<string | null>(null);
  return <main className="token-flow" style={{ maxWidth: 1100, margin: 'auto' }}>
    <h2>Token Flow</h2><p>Synthetic screenshot topology · All available · partial</p>
    <TokenFlowCanvas bot={{ id: 'fixture', name: 'botling' } as BotView} workers={allocation.nodes} allocationEdges={allocation.edges} rootOutput={allocation.known} rootLabel="All available · partial" basis="tokens" selected={selected} onSelect={onSelect} />
    <output aria-label="Selected detail">{selected ?? 'Select a card'}</output>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
