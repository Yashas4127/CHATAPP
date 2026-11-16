import { useEffect, useRef, useState } from "react";
import { Paperclip, Send, Smile } from "lucide-react";
import { api } from "../api.js";
import { Spinner } from "../components.jsx";

const REACTIONS = ["👍", "❤️", "😂", "🎉", "👀"];
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "application/pdf", "text/plain"]);

function stableGuestId(roomKey) {
  const key = `wc_room_guest_${roomKey}`;
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = globalThis.crypto?.randomUUID?.().replace(/-/g, "") || Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem(key, id);
  }
  return id;
}

function mergeMessage(list, next) {
  const merged = [...list.filter((message) => message.id !== next.id), next];
  return merged.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

export default function RoomChat({ kind, code, displayName, socket }) {
  const roomKey = `${kind}:${code}`;
  const guestId = stableGuestId(roomKey);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [typingUsers, setTypingUsers] = useState({});
  const endRef = useRef(null);
  const lastTypingSent = useRef(0);
  const stopTypingTimer = useRef();
  const typingTimers = useRef(new Map());

  useEffect(() => {
    let active = true;
    api(`/rooms/${kind}/${encodeURIComponent(code)}/messages`)
      .then(({ messages: history }) => {
        if (active) {
          setMessages((current) => history.reduce(mergeMessage, current));
          setError("");
        }
      })
      .catch((err) => active && setError(err.message))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [kind, code]);

  useEffect(() => {
    if (!socket) return undefined;
    const add = (message) => setMessages((current) => mergeMessage(current, message));
    const onTyping = (event) => {
      if (event.socketId === socket.id) return;
      window.clearTimeout(typingTimers.current.get(event.socketId));
      if (!event.isTyping) {
        typingTimers.current.delete(event.socketId);
        setTypingUsers((current) => {
          const next = { ...current };
          delete next[event.socketId];
          return next;
        });
        return;
      }
      setTypingUsers((current) => ({ ...current, [event.socketId]: event.name }));
      typingTimers.current.set(event.socketId, window.setTimeout(() => {
        typingTimers.current.delete(event.socketId);
        setTypingUsers((current) => {
          const next = { ...current };
          delete next[event.socketId];
          return next;
        });
      }, 4000));
    };
    socket.on("room:message", add);
    socket.on("message:receive", add);
    socket.on("room:message-updated", add);
    socket.on("room:typing", onTyping);
    socket.on("typing:start", (e) => onTyping({ ...e, isTyping: true, name: e.username }));
    socket.on("typing:stop", (e) => onTyping({ ...e, isTyping: false }));
    return () => {
      socket.off("room:message", add);
      socket.off("message:receive", add);
      socket.off("room:message-updated", add);
      socket.off("room:typing", onTyping);
      socket.off("typing:start");
      socket.off("typing:stop");
      typingTimers.current.forEach((timer) => window.clearTimeout(timer));
      typingTimers.current.clear();
    };
  }, [socket]);

  useEffect(() => () => {
    window.clearTimeout(stopTypingTimer.current);
    if (socket?.connected) socket.emit("room:typing", { isTyping: false });
  }, [socket]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages.length]);

  const selectFile = (event) => {
    const selected = event.target.files?.[0];
    event.target.value = "";
    if (!selected) return;
    if (!ACCEPTED_TYPES.has(selected.type)) {
      setError("Choose a PNG, JPEG, GIF, PDF, or plain-text file.");
      return;
    }
    if (selected.size > MAX_FILE_BYTES) {
      setError("Attachments must be 2 MB or smaller.");
      return;
    }
    setFile(selected);
    setError("");
  };

  const send = async (event) => {
    event.preventDefault();
    if ((!text.trim() && !file) || sending) return;
    setSending(true);
    setError("");
    try {
      let attachment;
      if (file) {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error("Could not read the selected file."));
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(file);
        });
        attachment = {
          name: file.name,
          mimeType: file.type,
          size: file.size,
          data: String(dataUrl).split(",")[1]
        };
      }
      const body = {
        text: text.trim(),
        ...(kind === "clipboard" ? { senderName: displayName, guestId } : {}),
        ...(attachment ? { attachment } : {})
      };
      const { message } = await api(`/rooms/${kind}/${encodeURIComponent(code)}/messages`, { method: "POST", body });
      setMessages((current) => mergeMessage(current, message));
      setText("");
      setFile(null);
      window.clearTimeout(stopTypingTimer.current);
      lastTypingSent.current = 0;
      socket?.emit("room:typing", { isTyping: false });
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  const changeText = (value) => {
    setText(value);
    const now = Date.now();
    if (socket?.connected && value.trim() && now - lastTypingSent.current > 1500) {
      lastTypingSent.current = now;
      socket.emit("room:typing", { isTyping: true });
      socket.emit("typing:start", { username: displayName });
    }
    window.clearTimeout(stopTypingTimer.current);
    if (value.trim()) {
      stopTypingTimer.current = window.setTimeout(() => {
        lastTypingSent.current = 0;
        socket?.emit("room:typing", { isTyping: false });
        socket?.emit("typing:stop", { username: displayName });
      }, 2500);
    } else {
      lastTypingSent.current = 0;
      socket?.emit("room:typing", { isTyping: false });
      socket?.emit("typing:stop", { username: displayName });
    }
  };

  const react = async (message, emoji) => {
    setError("");
    try {
      const body = { emoji, ...(kind === "clipboard" ? { guestId } : {}) };
      const { message: updated } = await api(
        `/rooms/${kind}/${encodeURIComponent(code)}/messages/${message.id}/reactions`,
        { method: "PATCH", body }
      );
      setMessages((current) => mergeMessage(current, updated));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section className="room-chat">
      <header className="room-chat-head">
        <div><h2>Room chat</h2><span className="muted">Separate from the shared document</span></div>
        <span className="room-chat-name">{displayName}</span>
      </header>
      <div className="room-chat-messages">
        {loading && <div className="center-inline"><Spinner /></div>}
        {!loading && messages.length === 0 && !error && <p className="muted room-chat-empty">No messages yet. Start the conversation.</p>}
        {messages.map((message) => (
          <article className="room-message" key={message.id}>
            <header><strong>{message.senderName}</strong><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></header>
            {message.text && <p>{message.text}</p>}
            {message.attachment && (
              <a className="room-attachment" href={`/api${message.attachment.url}`} download={message.attachment.name}>
                {message.attachment.mimeType.startsWith("image/") && (
                  <img src={`/api${message.attachment.url}`} alt={message.attachment.name} />
                )}
                <span>{message.attachment.name}</span>
              </a>
            )}
            <footer className="room-reactions">
              {message.reactions.map((reaction) => (
                <button key={reaction.emoji} type="button" onClick={() => react(message, reaction.emoji)} aria-label={`${reaction.emoji} reaction, ${reaction.count} total`}>
                  {reaction.emoji} {reaction.count}
                </button>
              ))}
              <details className="room-react-picker">
                <summary aria-label="Add reaction"><Smile size={14} /></summary>
                <span>{REACTIONS.map((emoji) => <button key={emoji} type="button" onClick={() => react(message, emoji)}>{emoji}</button>)}</span>
              </details>
            </footer>
          </article>
        ))}
        {Object.keys(typingUsers).length > 0 && <p className="room-typing">{Object.values(typingUsers).join(", ")} {Object.keys(typingUsers).length === 1 ? "is" : "are"} typing…</p>}
        <div ref={endRef} />
      </div>
      {error && <p className="alert small room-chat-error">{error}</p>}
      <form className="room-chat-composer" onSubmit={send}>
        {file && <div className="room-selected-file">{file.name}<button type="button" onClick={() => setFile(null)} aria-label="Remove attachment">×</button></div>}
        <div>
          <label className="icon-btn" title="Attach an image, PDF, or text file">
            <Paperclip size={17} />
            <input type="file" accept="image/gif,image/jpeg,image/png,application/pdf,text/plain" onChange={selectFile} hidden />
          </label>
          <textarea rows={1} maxLength={2000} value={text} onChange={(event) => changeText(event.target.value)} placeholder="Message this room…" />
          <button className="btn primary send-btn" disabled={sending || (!text.trim() && !file)} aria-label="Send room message">
            {sending ? <Spinner /> : <Send size={17} />}
          </button>
        </div>
      </form>
    </section>
  );
}
