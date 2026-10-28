import React, { useEffect, useRef, useState } from 'react';
import { MobileError, MobileTransport, endpointURL, type MobileSnapshot, type MobileCommand } from './transport';
import { Session, sessionRequest, loadDrafts, saveDrafts, clearDrafts, type BrowserSession } from './session';
import type { MessageView } from '../src/contract';

export function App() {
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [authState, setAuthState] = useState<'checking' | 'ready' | 'signedOut' | 'denied' | 'unavailable'>('checking');
  const draftOwner = useRef('');
  const connecting = useRef(false);
  const [client, setClient] = useState<MobileTransport | null>(null);
  const [snapshot, setSnapshot] = useState<MobileSnapshot | null>(null);
  const [selected, setSelected] = useState<string>();
  const [navigation, setNavigation] = useState(() => window.matchMedia?.('(min-width: 601px)').matches ?? false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reply, setReply] = useState<MessageView | null>(null);
  const [target, setTarget] = useState('both');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [refreshed, setRefreshed] = useState('');
  const [revision, setRevision] = useState(0);
  const [uncertain, setUncertain] = useState(false);
  const [question, setQuestion] = useState<MessageView | null>(null);
  const [answer, setAnswer] = useState('');
  const [visibleCount, setVisibleCount] = useState(100);
  const current = useRef(client); current.current = client;
  const generation = useRef(0);
  const actionLock = useRef(false);
  const pollPending = useRef(false);
  const messages = useRef<HTMLElement>(null);
  const follow = useRef(true);
  const bot = snapshot?.bots.find(row => row.id === selected);
  const chat = snapshot?.chat && snapshot.chat.botId === selected ? snapshot.chat : null;
  const draft = selected ? drafts[selected] ?? '' : '';

  function disconnect(discardDrafts = true) {
    generation.current++;
    client?.close(); current.current = null; setClient(null); setSnapshot(null); setSelected(undefined);
    if (discardDrafts) { setDrafts({}); clearDrafts(); draftOwner.current = ''; }
    setSession(null); setAuthState('signedOut');
    setReply(null); setQuestion(null); setAnswer(''); setBusy(false);
    actionLock.current = false; setLoading(false); setRefreshed(''); if (discardDrafts) setUncertain(false);
  }
  function fail(cause: unknown) {
    setError(cause instanceof Error ? cause.message : 'Request failed.');
    if (cause instanceof MobileError && cause.auth) disconnect(false);
    if (cause instanceof MobileError && cause.uncertain) setUncertain(true);
  }
  async function connect() {
    if (connecting.current) return;
    connecting.current = true; setAuthState('checking'); setError('');
    try {
      const next = Session.parse(await sessionRequest('session'));
      if (next.expiresAt <= Date.now()) throw new MobileError('Session expired. Sign in again.', true);
      const restored = draftOwner.current === next.principal ? drafts : loadDrafts(next.principal);
      draftOwner.current = next.principal; setDrafts(restored);
      setSession(next); setClient(new MobileTransport(endpointURL('/api/mobile/browser/command', location.origin), { csrf: next.csrf }));
      setSelected(next.botIds[0]); setAuthState('ready');
    } catch (cause) {
      setAuthState(cause instanceof MobileError ? cause.auth ? 'signedOut' : cause.denied ? 'denied' : 'unavailable' : 'unavailable');
      setError(cause instanceof MobileError ? cause.message : 'Sign-in is unavailable. Try again.');
    } finally { connecting.current = false; }
  }
  async function logout() {
    if (!session || actionLock.current) return;
    actionLock.current = true; setBusy(true);
    try {
      await sessionRequest('logout', session.csrf);
      disconnect(); window.location.assign('/cdn-cgi/access/logout');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not sign out. Try again.'); }
    finally { actionLock.current = false; setBusy(false); }
  }
  useEffect(() => { void connect(); }, []);
  useEffect(() => { if (draftOwner.current) saveDrafts(draftOwner.current, drafts); }, [drafts]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  useEffect(() => {
    if (!client) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const version = ++generation.current;
    const refresh = async () => {
      clearTimeout(timer);
      if (stopped || document.hidden || !navigator.onLine) return;
      // Shared across effect generations so selection/reconnect cannot overlap reads.
      if (pollPending.current) { timer = setTimeout(refresh, 100); return; }
      pollPending.current = true; setLoading(true);
      try {
        const next = await client.snapshot(selected);
        if (stopped || version !== generation.current) return;
        setSnapshot(next); setError(''); setRefreshed(new Date().toLocaleTimeString());
        if (!selected && next.chat) setSelected(next.chat.botId);
      } catch (cause) { if (!stopped && version === generation.current) fail(cause); }
      finally {
        pollPending.current = false;
        if (!stopped) { setLoading(false); clearTimeout(timer); timer = setTimeout(refresh, 5_000); }
      }
    };
    const resume = () => { if (timer) clearTimeout(timer); void refresh(); };
    void refresh();
    document.addEventListener('visibilitychange', resume); window.addEventListener('online', resume);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', resume); };
  }, [client, selected, revision]);
  useEffect(() => { if (follow.current && messages.current) messages.current.scrollTop = messages.current.scrollHeight; }, [chat]);
  useEffect(() => () => client?.close(), [client]);

  async function act(command: MobileCommand, done: () => void) {
    if (!client || actionLock.current || !online) return;
    const owner = client;
    actionLock.current = true; setBusy(true); setError('');
    try {
      await owner.request(command);
      if (current.current !== owner) return;
      done(); setRevision(value => value + 1);
    } catch (cause) { if (current.current === owner) fail(cause); }
    finally { if (current.current === owner) { actionLock.current = false; setBusy(false); } }
  }
  function chooseBot(id: string) {
    if (id !== selected) generation.current++;
    setVisibleCount(100); setSelected(id); setNavigation(false); setReply(null); setQuestion(null); setAnswer(''); setTarget('both'); follow.current = true;
  }
  const canSend = Boolean(client && chat && online && !busy && !uncertain && !bot?.problem && !chat.pendingFiles?.length);

  return <div className="app">
    <header><button onClick={() => setNavigation(!navigation)} aria-expanded={navigation} aria-controls="chats">Chats</button><div><strong>{bot?.name ?? 'Botling'}</strong><small>{client ? !online ? 'Offline · draft kept in this tab' : loading ? 'Refreshing…' : `Updated ${refreshed || '…'}` : 'Mobile'}</small></div>{client && <button disabled={busy} onClick={() => void logout()}>Sign out</button>}</header>
    {error && <div className="banner" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
    {!client ? <main className="connect" aria-busy={authState === 'checking'}><h1>Your bots, with you.</h1>
      <p>Sign in with the Google account approved by your Botling owner. Only explicitly shared chats are available.</p>
      {authState === 'checking' ? <p role="status">Checking your session…</p> : <>
        <button className="primary" onClick={() => { window.location.assign('/api/mobile/login'); }}>Sign in with Google</button>
        <button onClick={() => void connect()}>Check connection</button>
      </>}
      <p className="muted">Keep Botling running on your computer. Drafts stay in this tab through sign-in; signing out clears them. No access token to copy.</p>
    </main> : <div className="workspace">
      <nav id="chats" className={navigation ? 'open' : ''} aria-label="Chats"><h2>Chats</h2>{!snapshot && <p>Waiting for the server…</p>}{snapshot?.bots.map(row => <button key={row.id} aria-current={selected === row.id ? 'page' : undefined} disabled={busy} onClick={() => chooseBot(row.id)}><strong>{row.name}</strong><small>{row.working ? 'Working' : row.role === 'manager' ? 'Project' : 'Ready'}{row.unread ? ` · ${row.unread} unread` : ''}{row.approvals ? ` · ${row.approvals} waiting` : ''}</small></button>)}</nav>
      <main className="conversation" aria-label="Conversation">
        <div className="chat-tools"><span>{bot?.working ? '● Working' : 'Chat'}</span><button onClick={() => { setError(''); setRevision(value => value + 1); }} disabled={loading}>Refresh</button></div>
        <section className="messages" ref={messages} aria-label="Messages" onScroll={() => { const node = messages.current!; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }}>
          {!chat && <p className="empty">{loading ? 'Loading conversation…' : 'Choose a chat to begin.'}</p>}
          {chat && !chat.messages.length && <p className="empty">Start a conversation with {bot?.name}.</p>}
          {chat && chat.messages.length > visibleCount && <button onClick={() => { follow.current = false; setVisibleCount(count => count + 100); }}>Show earlier messages</button>}
          {chat?.messages.slice(-visibleCount).map(message => <article key={message.id} className={`message ${message.role}`}><div className="byline"><strong>{message.role === 'user' ? 'You' : message.engine ?? bot?.name}</strong><time>{new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>{message.replyPreview && <blockquote>{message.replyPreview}</blockquote>}<div className="text">{message.text}</div>{message.state === 'streaming' && <small>Writing…</small>}{message.attachments?.map((file, index) => <p className="muted" key={index}>Attachment: {file.name} · open on desktop</p>)}{Boolean(message.cards?.length || message.displays?.length || message.previews?.length) && <p className="muted">Open rich content on desktop.</p>}
            {message.choices?.length && message.chosen == null && message.answer == null ? <div className="choices">{message.approval && <p>Approval: {message.approval.tool}</p>}{message.choices.map((choice, index) => <button key={index} disabled={!canSend} onClick={() => void act({ type: 'chat.choose', botId: chat.botId, messageId: message.id, index }, () => {})}>{choice.label}{choice.detail && <small>{choice.detail}</small>}</button>)}{!message.approval && <button disabled={!canSend} onClick={() => { setQuestion(message); setAnswer(''); }}>Answer in words</button>}</div> : null}
            {message.chosen != null && <small>Selected: {message.choices?.[message.chosen]?.label}</small>}{message.answer && <small>Answered: {message.answer}</small>}
            <button className="reply" disabled={busy} onClick={() => { setReply(message); document.getElementById('compose')?.focus(); }}>Reply</button>
          </article>)}
          {chat?.tasks.length ? <details><summary>Tasks ({chat.tasks.length})</summary>{chat.tasks.map(task => <p key={task.id}><strong>{task.name}</strong> · {task.state}<br />{task.blocked || task.now}</p>)}</details> : null}
        </section>
        {uncertain && <div className="banner">A request may have reached the bot. Check the refreshed conversation before retrying.<button onClick={() => setUncertain(false)}>I checked the chat</button></div>}
        {question && <form className="answer" onSubmit={event => { event.preventDefault(); if (chat && answer.trim()) void act({ type: 'chat.answer', botId: chat.botId, messageId: question.id, text: answer }, () => { setQuestion(null); setAnswer(''); }); }}><label>Answer to: {question.text.slice(0, 160)}<textarea value={answer} maxLength={100000} onChange={event => setAnswer(event.target.value)} /></label><button disabled={!canSend || !answer.trim()}>Send answer</button><button type="button" onClick={() => setQuestion(null)}>Cancel</button></form>}
        <form className="composer" onSubmit={event => { event.preventDefault(); if (!selected || !canSend || !draft.trim()) return; const id = selected, sent = draft; void act({ type: 'chat.send', botId: id, text: sent, ...(reply ? { replyTo: reply.id } : {}), ...(bot?.heads.length === 2 ? { to: target as 'both' | 'claude' | 'codex' } : {}) }, () => { setDrafts(values => values[id] === sent ? { ...values, [id]: '' } : values); setReply(null); follow.current = true; }); }}>
          {reply && <div className="reply-preview">Replying to: {reply.text.slice(0, 100)}<button type="button" onClick={() => setReply(null)} aria-label="Cancel reply">×</button></div>}
          {bot?.problem && <p role="alert">{bot.problem}</p>}{Boolean(chat?.pendingFiles?.length) && <p>Files are queued on desktop. Send or remove them there before sending from mobile.</p>}
          {bot?.heads.length === 2 && <label className="target">Send to<select value={target} onChange={event => setTarget(event.target.value)}><option value="both">Both</option><option value="claude">Claude</option><option value="codex">Codex</option></select></label>}
          <div className="compose-row"><textarea id="compose" aria-label="Message" placeholder="Message your bot…" rows={2} maxLength={100000} disabled={!chat || busy} value={draft} onChange={event => { if (selected) setDrafts(values => ({ ...values, [selected]: event.target.value })); }} /><button className="primary" disabled={!canSend || !draft.trim()}>{busy ? 'Sending…' : 'Send'}</button></div>
        </form>
      </main>
    </div>}
  </div>;
}
