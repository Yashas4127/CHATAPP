import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ClipboardPlus, Lock, LogOut, MessageCircle, Send, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { ENCRYPTION_NOTE, api, formatDay, formatShort, formatTime } from "../api.js";
import { useAuth } from "../AuthContext.jsx";
import { ThemeToggle } from "../ThemeContext.jsx";
import { Avatar, Spinner } from "../components.jsx";

/* ---------------------------------------------------------------- new chat */
function NewChat({ onOpen }) {
  const [value, setValue] = useState("");
  const [results, setResults] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const clean = (text) => text.trim().toLowerCase().replace(/^@/, "");

  useEffect(() => {
    const q = clean(value);
    if (!q) { setResults([]); return undefined; }
    let alive = true;
    const timer = setTimeout(() => {
      api(`/users/search?q=${encodeURIComponent(q)}`)
        .then((data) => alive && setResults(data.users))
        .catch(() => alive && setResults([]));
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [value]);

  const start = async (username) => {
    setBusy(true);
    setError("");
    try {
      const data = await api("/conversations", { method: "POST", body: { username } });
      setValue("");
      setResults([]);
      onOpen(data.conversation);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (event) => {
    event.preventDefault();
    if (clean(value)) start(clean(value));
  };

  return (
    <div className="new-chat">
      <form onSubmit={submit}>
        <UserPlus size={16} />
        <input
          value={value} onChange={(e) => { setValue(e.target.value); setError(""); }}
          placeholder="Find a username to chat…" autoCapitalize="none" autoComplete="off" spellCheck="false" maxLength={21}
        />
        <button className="btn small primary" disabled={busy || !clean(value)}>{busy ? <Spinner /> : "Chat"}</button>
      </form>
      {error && <div className="alert small">{error}</div>}
      {results.length > 0 && (
        <ul className="suggestions">
          {results.map((person) => (
            <li key={person.id}>
              <button type="button" onClick={() => start(person.username)} disabled={busy}>
                <Avatar name={person.username} size={28} /> @{person.username}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ thread */
function Thread({ conversation, onBack, onRead, reloadKey }) {
  const { user, socket } = useAuth();
  const convId = conversation.id;
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [typing, setTyping] = useState(false);
  const endRef = useRef(null);
  const lastTypingSent = useRef(0);
  const stopTypingTimer = useRef();
  const clearTypingTimer = useRef();

  // History
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api(`/conversations/${convId}/messages`)
      .then((data) => { if (alive) { setMessages(data.messages); setError(""); onRead(convId); } })
      .catch((err) => alive && setError(err.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [convId, reloadKey, onRead]);

  // Live updates
  useEffect(() => {
    if (!socket) return undefined;
    const onNew = ({ conversationId, message }) => {
      if (conversationId !== convId) return;
      setMessages((items) => (items.some((m) => m.id === message.id) ? items : [...items, message]));
      if (message.senderId !== user.id) { setTyping(false); onRead(convId); }
    };
    const onDeleted = ({ conversationId, messageId }) => {
      if (conversationId === convId) setMessages((items) => items.filter((m) => m.id !== messageId));
    };
    const onTyping = (event) => {
      if (event.conversationId !== convId || event.userId === user.id) return;
      setTyping(event.isTyping);
      window.clearTimeout(clearTypingTimer.current);
      if (event.isTyping) clearTypingTimer.current = window.setTimeout(() => setTyping(false), 5000);
    };
    socket.on("message:new", onNew);
    socket.on("message:deleted", onDeleted);
    socket.on("typing", onTyping);
    return () => {
      socket.off("message:new", onNew);
      socket.off("message:deleted", onDeleted);
      socket.off("typing", onTyping);
    };
  }, [socket, convId, user.id, onRead]);

  useEffect(() => () => {
    window.clearTimeout(stopTypingTimer.current);
    window.clearTimeout(clearTypingTimer.current);
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [messages.length, typing, loading]);

  const send = async (event) => {
    event?.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError("");
    try {
      const data = await api(`/conversations/${convId}/messages`, { method: "POST", body: { text: body } });
      setMessages((items) => (items.some((m) => m.id === data.message.id) ? items : [...items, data.message]));
      setText("");
      window.clearTimeout(stopTypingTimer.current);
      lastTypingSent.current = 0;
      socket?.emit("typing", { conversationId: convId, isTyping: false });
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  const onChange = (value) => {
    setText(value);
    const now = Date.now();
    if (socket && now - lastTypingSent.current > 2000) {
      lastTypingSent.current = now;
      socket.emit("typing", { conversationId: convId, isTyping: true });
    }
    window.clearTimeout(stopTypingTimer.current);
    stopTypingTimer.current = window.setTimeout(() => {
      lastTypingSent.current = 0;
      socket?.emit("typing", { conversationId: convId, isTyping: false });
    }, 2500);
  };

  const remove = async (message) => {
    if (!window.confirm("Delete this message for everyone?")) return;
    try {
      await api(`/messages/${message.id}`, { method: "DELETE" });
      setMessages((items) => items.filter((m) => m.id !== message.id));
    } catch (err) {
      setError(err.message);
    }
  };

  let lastDay = "";
  return (
    <>
      <header className="thread-head">
        <button className="icon-btn back-btn" onClick={onBack} aria-label="Back to chats"><ArrowLeft size={20} /></button>
        <Avatar name={conversation.other.username} />
        <div className="grow">
          <strong>@{conversation.other.username}</strong>
          <small className={conversation.other.online ? "online-text" : "muted"}>
            {typing ? "typing…" : conversation.other.online ? "online" : "offline"}
          </small>
        </div>
        <span className="enc-badge" title={ENCRYPTION_NOTE}><Lock size={13} /> Encrypted</span>
      </header>

      <div className="messages">
        <div className="enc-note"><Lock size={13} /> {ENCRYPTION_NOTE}</div>
        {loading && <div className="center-inline"><Spinner /></div>}
        {!loading && messages.length === 0 && !error && (
          <div className="empty">
            <MessageCircle size={34} />
            <p>No messages yet. Say hi to @{conversation.other.username}!</p>
          </div>
        )}
        {messages.map((message) => {
          const day = formatDay(message.createdAt);
          const showDay = day !== lastDay;
          lastDay = day;
          const mine = message.senderId === user.id;
          return (
            <div key={message.id}>
              {showDay && <div className="day-divider"><span>{day}</span></div>}
              <div className={`bubble-row ${mine ? "mine" : ""}`}>
                {mine && <button className="icon-btn tiny delete-btn" onClick={() => remove(message)} aria-label="Delete message"><Trash2 size={14} /></button>}
                <div className="bubble">
                  <p>{message.text}</p>
                  <time>{formatTime(message.createdAt)}</time>
                </div>
              </div>
            </div>
          );
        })}
        {typing && <div className="typing-dots"><span /><span /><span /></div>}
        <div ref={endRef} />
      </div>

      {error && <div className="alert floating">{error}</div>}
      <form className="composer" onSubmit={send}>
        <textarea
          rows={1} value={text} maxLength={4000} placeholder="Write a message…"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <button className="btn primary send-btn" disabled={!text.trim() || sending} aria-label="Send">
          {sending ? <Spinner /> : <Send size={18} />}
        </button>
      </form>
    </>
  );
}

/* -------------------------------------------------------------------- page */
export default function ChatPage() {
  const { user, socket, connected, logout } = useAuth();
  const { id: activeId } = useParams();
  const navigate = useNavigate();
  const [convs, setConvs] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const convsRef = useRef(convs);
  const activeRef = useRef(activeId);
  convsRef.current = convs;
  activeRef.current = activeId;

  const loadConvs = useCallback(async () => {
    try {
      const data = await api("/conversations");
      setConvs(data.conversations);
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => { loadConvs(); }, [loadConvs]);

  // After a dropped connection comes back, catch up on anything we missed.
  const seenConnect = useRef(false);
  useEffect(() => {
    if (!connected) return;
    if (!seenConnect.current) { seenConnect.current = true; return; }
    loadConvs();
    setReloadKey((n) => n + 1);
  }, [connected, loadConvs]);

  useEffect(() => {
    if (!socket) return undefined;
    const onNew = ({ conversationId, message }) => {
      if (!convsRef.current.some((c) => c.id === conversationId)) { loadConvs(); return; }
      const mine = message.senderId === user.id;
      const open = conversationId === activeRef.current;
      setConvs((list) => {
        const index = list.findIndex((c) => c.id === conversationId);
        if (index < 0) return list;
        const current = list[index];
        const updated = {
          ...current,
          lastMessage: { text: message.text, at: message.createdAt, mine },
          lastMessageAt: message.createdAt,
          unread: mine ? current.unread : open ? 0 : current.unread + 1
        };
        return [updated, ...list.filter((_, i) => i !== index)];
      });
    };
    const onPresence = ({ userId, online }) =>
      setConvs((list) => list.map((c) => (c.other.id === userId ? { ...c, other: { ...c.other, online } } : c)));
    const onDeleted = () => loadConvs();
    socket.on("message:new", onNew);
    socket.on("presence", onPresence);
    socket.on("message:deleted", onDeleted);
    return () => {
      socket.off("message:new", onNew);
      socket.off("presence", onPresence);
      socket.off("message:deleted", onDeleted);
    };
  }, [socket, user.id, loadConvs]);

  // Opening /chat/:id directly (bookmark, refresh, fresh chat started elsewhere)
  useEffect(() => {
    if (!activeId || !loaded || convs.some((c) => c.id === activeId)) return undefined;
    let alive = true;
    api(`/conversations/${activeId}`)
      .then((data) => alive && setConvs((list) => (list.some((c) => c.id === activeId) ? list : [data.conversation, ...list])))
      .catch(() => alive && navigate("/chat", { replace: true }));
    return () => { alive = false; };
  }, [activeId, loaded, convs, navigate]);

  const markRead = useCallback((id) => {
    api(`/conversations/${id}/read`, { method: "POST" }).catch(() => {});
    setConvs((list) => list.map((c) => (c.id === id && c.unread ? { ...c, unread: 0 } : c)));
  }, []);

  const openChat = (conversation) => {
    setConvs((list) => (list.some((c) => c.id === conversation.id) ? list : [conversation, ...list]));
    navigate(`/chat/${conversation.id}`);
  };

  const active = convs.find((c) => c.id === activeId);

  return (
    <div className={`app-shell ${activeId ? "has-active" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="brand"><MessageCircle size={22} /> WebChat</div>
          <div className="head-actions">
            <Link to="/clipboard/new" className="icon-btn" title="Create Clipboard"><ClipboardPlus size={19} /></Link>
            {user.role === "admin" && <Link to="/admin" className="icon-btn" title="Admin dashboard"><ShieldCheck size={19} /></Link>}
            <ThemeToggle />
            <button className="icon-btn" onClick={logout} title="Log out"><LogOut size={19} /></button>
          </div>
        </div>
        <div className="me-line">
          <Avatar name={user.username} size={34} />
          <div className="grow">
            <strong>@{user.username}</strong>
            {user.role === "admin" && <span className="role-pill">admin</span>}
          </div>
          <span className={`status-dot ${connected ? "on" : ""}`} title={connected ? "Connected" : "Reconnecting…"} />
        </div>

        <NewChat onOpen={openChat} />
        {error && <div className="alert small">{error}</div>}

        <div className="conv-list">
          {!loaded && <div className="center-inline"><Spinner /></div>}
          {loaded && convs.length === 0 && !error && (
            <div className="empty small">
              <p>No chats yet.</p>
              <p className="muted">Search for a username above to start one.</p>
            </div>
          )}
          {convs.map((c) => (
            <Link key={c.id} to={`/chat/${c.id}`} className={`conv-row ${c.id === activeId ? "active" : ""}`}>
              <span className="avatar-wrap">
                <Avatar name={c.other.username} />
                {c.other.online && <i className="presence-dot" />}
              </span>
              <div className="grow">
                <div className="conv-top">
                  <strong>@{c.other.username}</strong>
                  {c.lastMessage && <small className="muted">{formatShort(c.lastMessage.at)}</small>}
                </div>
                <div className="conv-bottom">
                  <span className="preview">{c.lastMessage ? `${c.lastMessage.mine ? "You: " : ""}${c.lastMessage.text}` : "No messages yet"}</span>
                  {c.unread > 0 && <span className="badge">{c.unread > 99 ? "99+" : c.unread}</span>}
                </div>
              </div>
            </Link>
          ))}
        </div>
      </aside>

      <section className="thread-pane">
        {!connected && socket && <div className="conn-banner">Reconnecting… new messages will appear when the connection is back.</div>}
        {active ? (
          <Thread key={active.id} conversation={active} onBack={() => navigate("/chat")} onRead={markRead} reloadKey={reloadKey} />
        ) : (
          <div className="empty big">
            {activeId && !loaded ? <Spinner /> : (
              <>
                <MessageCircle size={48} />
                <h2>Your messages</h2>
                <p className="muted">Pick a chat, or search a username to start a new one.</p>
                <p className="enc-note inline"><Lock size={13} /> {ENCRYPTION_NOTE}</p>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
