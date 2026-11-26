import { useEffect, useRef } from "react";
import { Sparkles, X } from "lucide-react";

function PatchNotesBody({ note }) {
  return (
    <div className="patch-notes-body">
      {note.sections.map((section) => (
        <section key={section.heading} className="patch-notes-group">
          <h4>{section.heading}</h4>
          <ul>{section.items.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
      ))}
    </div>
  );
}

// Shown once when the app opens with notes the user has not seen.
export function WhatsNewDialog({ note, onClose, onOpenAll }) {
  const closeButton = useRef(null);
  useEffect(() => {
    closeButton.current?.focus();
    const onKey = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="whats-new-backdrop" onClick={onClose}>
      <div className="whats-new-dialog card" role="dialog" aria-modal="true" aria-labelledby="whats-new-title"
        onClick={(event) => event.stopPropagation()}>
        <div className="whats-new-header">
          <span className="settings-icon"><Sparkles size={20} /></span>
          <div>
            <small className="eyebrow">WHAT'S NEW · {note.date.toUpperCase()}</small>
            <h2 id="whats-new-title">{note.title}</h2>
          </div>
          <button type="button" className="whats-new-close" aria-label="Close" ref={closeButton} onClick={onClose}><X size={20} /></button>
        </div>
        <PatchNotesBody note={note} />
        <div className="whats-new-actions">
          <button type="button" className="secondary" onClick={onOpenAll}>All patch notes</button>
          <button type="button" className="primary" onClick={onClose}>Got it</button>
        </div>
      </div>
    </div>
  );
}

// Every release, newest first; the newest is open.
export function PatchNotesList({ notes }) {
  return (
    <div className="patch-notes-list">
      {notes.map((note, index) => (
        <details key={note.id} className="patch-notes-release" open={index === 0}>
          <summary>
            <strong>{note.title}</strong>
            <small>{note.date}</small>
          </summary>
          <PatchNotesBody note={note} />
        </details>
      ))}
    </div>
  );
}
