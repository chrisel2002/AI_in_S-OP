import { useState, useRef, useEffect } from "react";
import { askChat } from "./api.js";

const SUGGESTIONS = [
  "Which signals are most critical right now?",
  "What should we do about the top signals this cycle?",
  "Which material has the highest forecast demand?",
  "How can we reduce stockout risk?",
];

export default function Chat() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
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

  if (!open) {
    return (
      <button className="chat-fab" onClick={() => setOpen(true)}>
        💬 Ask the assistant
      </button>
    );
  }

  return (
    <div className="chat-panel">
      <div className="chat-head">
        <span>💬 S&amp;OP Assistant</span>
        <button className="chat-close" onClick={() => setOpen(false)}>✕</button>
      </div>
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
          <div key={i} className={`chat-msg chat-${m.role}`}>{m.content}</div>
        ))}
        {loading && <div className="chat-msg chat-assistant">Thinking…</div>}
        <div ref={endRef} />
      </div>
      <div className="chat-input">
        <input
          value={input}
          placeholder="Ask a question…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button className="btn btn-primary" onClick={() => send()} disabled={loading}>Send</button>
      </div>
    </div>
  );
}
