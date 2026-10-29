import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TerminalPanels } from '../../src/renderer/TerminalPanel';
function Harness() {
  const [toggleHost, setToggleHost] = useState<HTMLSpanElement | null>(null);
  const [bot, setBot] = useState('A');
  return <div style={{height:'100vh',display:'flex',flexDirection:'column',background:'#17191e',color:'white'}}>
    <header className="chat-header"><span>Terminal layout test</span><span ref={setToggleHost} /><button onClick={() => setBot('A')}>Bot A</button><button onClick={() => setBot('B')}>Bot B</button></header>
    <div data-testid="content" style={{flex:1,minHeight:0,padding:20}}>Project {bot} · independent interactive shells</div>
    <TerminalPanels {...{ toggleHost }} botId={bot} botIds={['A','B']} />
  </div>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
