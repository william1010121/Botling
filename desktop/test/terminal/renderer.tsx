import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TerminalPanels } from '../../src/renderer/TerminalPanel';
function Harness() {
  const [bot, setBot] = useState('A');
  return <div style={{height:'100vh',display:'flex',flexDirection:'column',background:'#17191e',color:'white'}}>
    <header><h2>Botling terminal · isolated interaction test</h2><button onClick={() => setBot('A')}>Bot A</button><button onClick={() => setBot('B')}>Bot B</button></header>
    <div style={{flex:1,padding:20}}>Project {bot} · independent interactive shells</div>
    <TerminalPanels botId={bot} botIds={['A','B']} />
  </div>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
