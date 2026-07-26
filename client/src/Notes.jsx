import { useState, useEffect, useRef } from "react";

function loadNotes() {
  try { return JSON.parse(localStorage.getItem("sop-notes") || "[]"); } catch { return []; }
}
function saveNotes(notes) {
  localStorage.setItem("sop-notes", JSON.stringify(notes));
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function shareNote(note) {
  const dateLabel = formatDate(note.updatedAt || note.createdAt);
  const filename = `SOP_Note_${dateLabel.replace(/[^a-zA-Z0-9]/g, "_")}.txt`;

  const fileContent = [
    "ThyssenKrupp — S&OP Planning Note",
    "=".repeat(40),
    `Date: ${dateLabel}`,
    "",
    note.text,
    "",
    "=".repeat(40),
    "Generated from the S&OP Signal Dashboard",
  ].join("\n");

  // Download the note as a .txt file
  const blob = new Blob([fileContent], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);

  // Open email client with a pre-filled template
  const subject = encodeURIComponent("S&OP Planning Note — Action Required");
  const body = encodeURIComponent(
    `Hi Team,\n\n` +
    `Please find below a planning note from the S&OP Signal Dashboard that requires your attention.\n\n` +
    `The note has also been attached as a text file (${filename}) for your records.\n\n` +
    `────────────────────────────────────────\n` +
    `NOTE (${dateLabel}):\n\n` +
    `${note.text}\n` +
    `────────────────────────────────────────\n\n` +
    `Please review and take the necessary actions at your earliest convenience.\n\n` +
    `If you have any questions or updates, feel free to reply to this email.\n\n` +
    `Best regards,\n` +
    `S&OP Planning Team\n` +
    `ThyssenKrupp`
  );

  window.location.href = `mailto:?subject=${subject}&body=${body}`;
}

export default function Notes({ chatOpen = false }) {
  const [open, setOpen] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const [notes, setNotes] = useState(loadNotes);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState("");
  const textareaRef = useRef(null);

  useEffect(() => {
    if (editingId !== null) textareaRef.current?.focus();
  }, [editingId]);

  function startNew() { setDraft(""); setEditingId("new"); }
  function startEdit(note) { setDraft(note.text); setEditingId(note.id); }
  function cancelEdit() { setDraft(""); setEditingId(null); }

  function saveEdit() {
    const text = draft.trim();
    if (!text) { cancelEdit(); return; }
    let updated;
    if (editingId === "new") {
      updated = [{ id: Date.now(), text, createdAt: new Date().toISOString() }, ...notes];
    } else {
      updated = notes.map((n) => n.id === editingId ? { ...n, text, updatedAt: new Date().toISOString() } : n);
    }
    setNotes(updated);
    saveNotes(updated);
    cancelEdit();
  }

  function deleteNote(id) {
    const updated = notes.filter((n) => n.id !== id);
    setNotes(updated);
    saveNotes(updated);
    if (editingId === id) cancelEdit();
  }

  function handleKey(e) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveEdit();
    if (e.key === "Escape") cancelEdit();
  }

  if (!open) {
    return (
      <button className={`notes-fab${chatOpen ? " notes-fab-beside-chat" : ""}`} onClick={() => setOpen(true)} title="Notes">
        📝
      </button>
    );
  }

  return (
    <div className={`notes-panel${enlarged ? " notes-panel-lg" : ""}${chatOpen ? " notes-panel-beside-chat" : ""}`}>
      <div className="notes-head">
        <span>📝 Notes</span>
        <div className="notes-head-actions">
          <button className="notes-icon-btn" onClick={startNew} title="New note">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
          <button className="notes-icon-btn" onClick={() => setEnlarged((v) => !v)} title={enlarged ? "Shrink" : "Expand"}>
            {enlarged ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
            )}
          </button>
          <button className="notes-icon-btn" onClick={() => { cancelEdit(); setOpen(false); }}>✕</button>
        </div>
      </div>

      <div className="notes-body">
        {editingId !== null && (
          <div className="note-editor">
            <textarea
              ref={textareaRef}
              className="note-textarea"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Write your note… (Ctrl+Enter to save)"
              rows={4}
            />
            <div className="note-editor-actions">
              <button className="btn btn-primary btn-sm" onClick={saveEdit}>Save</button>
              <button className="btn btn-sm" onClick={cancelEdit}>Cancel</button>
            </div>
          </div>
        )}

        {notes.length === 0 && editingId === null && (
          <div className="notes-empty">
            No notes yet. Click <strong>+</strong> to add one.
          </div>
        )}

        {notes.map((note) => (
          <div key={note.id} className={`note-card${editingId === note.id ? " note-card-editing" : ""}`}>
            {editingId === note.id ? null : (
              <>
                <div className="note-text">{note.text}</div>
                <div className="note-footer">
                  <span className="note-date">{formatDate(note.updatedAt || note.createdAt)}</span>
                  <div className="note-actions">
                    <button className="notes-icon-btn notes-icon-btn-share" onClick={() => shareNote(note)} title="Share via email">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                        <polyline points="22,6 12,13 2,6"/>
                      </svg>
                    </button>
                    <button className="notes-icon-btn" onClick={() => startEdit(note)} title="Edit">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z"/>
                      </svg>
                    </button>
                    <button className="notes-icon-btn notes-icon-btn-danger" onClick={() => deleteNote(note.id)} title="Delete">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                        <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
                      </svg>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
