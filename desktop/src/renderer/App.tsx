import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CardView, MessageView } from "../contract";
import { Client, RequestFailed } from "./client";
import { ChatStore } from "./store";
import { CardBroker, type CardTarget } from "./broker";

export function App({ client, store, broker }: { client: Client; store: ChatStore; broker: CardBroker }) {
  const view = useSyncExternalStore(store.subscribe, store.getView);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLElement>(null);
  const pinned = useRef(true);

  // Follow new text while the user is at the bottom; leave them be when they scrolled up.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [view.messages]);

  const send = async (text: string) => {
    setError(null);
    try {
      await client.request({ type: "chat.send", text });
      return true;
    } catch (failure) {
      setError(failure instanceof RequestFailed ? failure.error.message : String(failure));
      return false;
    }
  };
  const stop = async () => {
    if (!view.running) return;
    try {
      await client.request({ type: "turn.stop", turnId: view.running });
    } catch (failure) {
      setError(failure instanceof RequestFailed ? failure.error.message : String(failure));
    }
  };

  return (
    <>
      <div className="titlebar" />
      <main
        id="scroller"
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}
      >
        <div id="messages" role="log" aria-live="polite" data-ready={view.ready ? "1" : "0"}>
          {view.messages.map((message) => (
            <Message key={message.id} message={message} broker={broker} />
          ))}
        </div>
      </main>
      {error && <div className="banner" role="alert">{error}</div>}
      <Composer running={view.running} onSend={send} onStop={stop} disabled={!view.ready} />
    </>
  );
}

function Message({ message, broker }: { message: MessageView; broker: CardBroker }) {
  const cards = message.cards?.map((card) => <Card key={card.id} messageId={message.id} card={card} broker={broker} />);
  if (message.role === "user") {
    return (
      <div className="row user" data-id={message.id}>
        <div className="user-body"><div className="bubble user-bubble">{message.text}</div></div>
      </div>
    );
  }
  const bubbleClass = message.role === "bot" ? "bot-bubble" : message.role === "error" ? "error-bubble" : "notice-bubble";
  const waiting = message.state === "streaming" && !message.text;
  return (
    <div className={`row ${message.role}`} data-id={message.id} data-state={message.state ?? ""}>
      <div className="bot-column">
        {waiting ? (
          <div className="bubble bot-bubble working" aria-label="Writing"><div className="dots"><span /><span /><span /></div></div>
        ) : (
          (message.text || !cards) && <div className={`bubble ${bubbleClass}`}>{message.text}</div>
        )}
        {cards}
        {message.state === "stopped" && <div className="state-line">Stopped</div>}
        {message.state === "failed" && message.role === "bot" && <div className="state-line">Did not finish</div>}
      </div>
    </div>
  );
}

function Card({ messageId, card, broker }: { messageId: string; card: CardView; broker: CardBroker }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(80);
  const target = useRef<CardTarget | null>(null);
  const src = useMemo(() => `botling-card://card/${encodeURIComponent(messageId)}/${encodeURIComponent(card.id)}`, [messageId, card.id]);

  useEffect(() => {
    if (!frame.current) return;
    const entry: CardTarget = { messageId, cardId: card.id, frame: frame.current, onSize: (h) => setHeight(Math.max(40, Math.min(h, 900))) };
    target.current = entry;
    const unregister = broker.register(entry);
    return () => { unregister(); target.current = null; };
  }, [broker, messageId, card.id]);

  // New data (from the core, e.g. another window saved) goes to the frame.
  useEffect(() => {
    if (target.current) broker.sendData(target.current, card.data);
  }, [broker, card.data]);

  return (
    <div className="card" data-card={card.id}>
      <iframe
        ref={frame}
        src={src}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title="Card"
        style={{ height }}
        onLoad={() => { if (target.current) broker.sendData(target.current, card.data); }}
      />
    </div>
  );
}

function Composer({ running, disabled, onSend, onStop }: {
  running: string | null; disabled: boolean; onSend: (text: string) => Promise<boolean>; onStop: () => void;
}) {
  const [text, setText] = useState("");
  const editor = useRef<HTMLTextAreaElement>(null);
  const submit = async () => {
    const value = text.trim();
    if (!value || running) return;
    if (await onSend(value)) setText("");
  };
  useLayoutEffect(() => {
    const element = editor.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [text]);
  return (
    <div id="composer-slot">
      <div className="composer">
        <div className="composer-row">
          <textarea
            ref={editor}
            className="editor"
            rows={1}
            placeholder="Message"
            aria-label="Message"
            value={text}
            disabled={disabled}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter is a new line; Enter that confirms IME input does neither.
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </div>
        <div className="composer-tools">
          <span className="composer-hint">{running ? "Writing…" : ""}</span>
          <span className="composer-gap" />
          {running ? (
            <button className="send stop" aria-label="Stop" title="Stop" onClick={onStop}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></svg>
            </button>
          ) : (
            <button className="send" aria-label="Send" title="Send" disabled={disabled || !text.trim()} onClick={() => void submit()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
