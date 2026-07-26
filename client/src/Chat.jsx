import { useState, useRef, useEffect } from "react";
import { askChat } from "./api.js";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const SUGGESTIONS = [
  "Which signals are most critical right now?",
  "What should we do about the top signals this cycle?",
  "Which material has the highest forecast demand?",
  "How can we reduce stockout risk?",
];

function saveHistory(history) {
  localStorage.setItem("chat-history", JSON.stringify(history.slice(0, 30)));
}

function loadHistory() {
  try { return JSON.parse(localStorage.getItem("chat-history") || "[]"); } catch { return []; }
}

function sessionTitle(messages) {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "Conversation";
  return first.content.length > 45 ? first.content.slice(0, 45) + "…" : first.content;
}

export default function Chat({ onOpenChange }) {
  const [open, setOpen] = useState(false);

  useEffect(() => { onOpenChange?.(open); }, [open]);
  const [enlarged, setEnlarged] = useState(false);
  const [messages, setMessages] = useState([]);
  const [history, setHistory] = useState(loadHistory);
  const [showHistory, setShowHistory] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function send(q) {
    const question = (q ?? input).trim();
    if (!question || loading) return;
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, { role: "user", content: question }]);
    setInput("");
    setLoading(true);
    try {
      const r = await askChat(question, history);
      setMessages((m) => [...m, { role: "assistant", content: r.answer }]);
    } catch {
      setMessages((m) => [...m, { role: "assistant", content: "Sorry, I couldn't reach the assistant." }]);
    } finally {
      setLoading(false);
    }
  }

  function archiveCurrent() {
    if (messages.length === 0) return;
    setHistory((prev) => {
      const next = [{ id: Date.now(), title: sessionTitle(messages), messages }, ...prev];
      saveHistory(next);
      return next;
    });
  }

  function startNewChat() {
    archiveCurrent();
    setMessages([]);
    setInput("");
    setShowHistory(false);
  }

  function loadSession(session) {
    archiveCurrent();
    setMessages(session.messages);
    setHistory((prev) => {
      const next = prev.filter((s) => s.id !== session.id);
      saveHistory(next);
      return next;
    });
    setShowHistory(false);
  }

  function deleteSession(id, e) {
    e.stopPropagation();
    setHistory((prev) => {
      const next = prev.filter((s) => s.id !== id);
      saveHistory(next);
      return next;
    });
  }

  if (!open) {
    return (
      <button className="chat-fab" onClick={() => setOpen(true)}>
        💬 Ask the assistant
      </button>
    );
  }

  return (
    <div className={`chat-panel${enlarged ? " chat-panel-lg" : ""}`}>
      <div className="chat-head">
        <span>💬 S&amp;OP Assistant</span>
        <div className="chat-head-actions">
          <button className="chat-close" onClick={() => setShowHistory((v) => !v)} title="Chat history">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </button>
          <button className="chat-close" onClick={startNewChat} title="New chat">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z"/></svg>
          </button>
          <button
            className="chat-close"
            onClick={() => setEnlarged((v) => !v)}
            title={enlarged ? "Shrink" : "Expand"}
          >
            {enlarged ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
            )}
          </button>
          <button className="chat-close" onClick={() => setOpen(false)}>✕</button>
        </div>
      </div>

      {showHistory ? (
        <div className="chat-history">
          <div className="chat-history-title">Previous chats</div>
          {history.length === 0 ? (
            <div className="chat-history-empty">No saved chats yet.</div>
          ) : (
            history.map((s) => (
              <button key={s.id} className="chat-history-item" onClick={() => loadSession(s)}>
                <span className="chat-history-label">{s.title}</span>
                <span className="chat-history-del" onClick={(e) => deleteSession(s.id, e)} title="Delete">✕</span>
              </button>
            ))
          )}
        </div>
      ) : (
        <div className="chat-body">
          {messages.length === 0 && (
            <div className="chat-empty">
              <div>Ask me about the current signals and plan data.</div>
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chat-chip" onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`chat-msg chat-${m.role}`}>
              {m.role === "assistant" ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{ table: ({ children }) => <div className="md-table-wrap"><table>{children}</table></div> }}
                >{m.content}</ReactMarkdown>
              ) : m.content}
            </div>
          ))}
          {loading && <div className="chat-msg chat-assistant">Thinking…</div>}
          <div ref={endRef} />
        </div>
      )}

      {!showHistory && (
        <div className="chat-input">
          <input
            value={input}
            placeholder="Ask a question…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
          />
          <button className="btn btn-primary" onClick={() => send()} disabled={loading}>Send</button>
        </div>
      )}
    </div>
  );
}
