import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { LogOut, MessageCircle, Search, ShieldCheck, Users } from "lucide-react";
import { api } from "../api.js";
import { useAuth } from "../AuthContext.jsx";
import { Avatar, Spinner } from "../components.jsx";
import { ThemeToggle } from "../ThemeContext.jsx";

export default function AdminPage() {
  const { user, socket, connected, logout } = useAuth();
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [messages, setMessages] = useState([]);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [tab, setTab] = useState("accounts");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const usersRef = useRef(users);
  const seenConnect = useRef(false);
  usersRef.current = users;

  const loadAll = useCallback(async () => {
    try {
      const [nextStats, nextUsers] = await Promise.all([api("/admin/stats"), api("/admin/users")]);
      setStats(nextStats);
      setUsers(nextUsers.users);
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadConversations = useCallback(async () => {
    try {
      const data = await api("/admin/conversations");
      setConversations(data.conversations);
      setActiveConversationId((current) => current || data.conversations[0]?.id || "");
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);
  useEffect(() => { if (tab === "messages") loadConversations(); }, [tab, loadConversations]);

  useEffect(() => {
    if (!connected) return;
    if (!seenConnect.current) { seenConnect.current = true; return; }
    loadAll();
  }, [connected, loadAll]);

  useEffect(() => {
    if (!socket) return undefined;
    const onPresence = ({ userId, online }) => {
      setUsers((list) => list.map((person) => (person.id === userId ? { ...person, online } : person)));
      setStats((current) => {
        if (!current) return current;
        const person = usersRef.current.find((item) => item.id === userId);
        if (!person || person.online === online) return current;
        return { ...current, online: Math.max(0, current.online + (online ? 1 : -1)) };
      });
    };
    socket.on("presence", onPresence);
    return () => socket.off("presence", onPresence);
  }, [socket]);

  useEffect(() => {
    if (!socket || tab !== "messages") return undefined;
    const onUpdated = () => loadConversations();
    const onMessage = ({ conversationId, message }) => {
      if (conversationId === activeConversationId) {
        setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]);
      }
      loadConversations();
    };
    const onDeleted = ({ conversationId, messageId }) => {
      if (conversationId === activeConversationId) setMessages((current) => current.filter((item) => item.id !== messageId));
    };
    socket.on("admin:conversation-updated", onUpdated);
    socket.on("admin:message", onMessage);
    socket.on("admin:message-deleted", onDeleted);
    return () => {
      socket.off("admin:conversation-updated", onUpdated);
      socket.off("admin:message", onMessage);
      socket.off("admin:message-deleted", onDeleted);
    };
  }, [socket, tab, activeConversationId, loadConversations]);

  useEffect(() => {
    if (!activeConversationId || tab !== "messages") {
      setMessages([]);
      return undefined;
    }
    let active = true;
    setLoadingMessages(true);
    setMessages([]);
    socket?.emit("admin:watch-conversation", { conversationId: activeConversationId });
    api(`/admin/conversations/${activeConversationId}/messages`)
      .then(({ messages: nextMessages }) => {
        if (!active) return;
        setMessages(nextMessages);
        setHasOlderMessages(nextMessages.length === 100);
      })
      .catch((err) => active && setError(err.message))
      .finally(() => active && setLoadingMessages(false));
    return () => {
      active = false;
      socket?.emit("admin:unwatch-conversation", { conversationId: activeConversationId });
    };
  }, [activeConversationId, tab, socket]);

  const loadOlderMessages = async () => {
    if (!activeConversationId || !messages.length || loadingOlder) return;
    setLoadingOlder(true);
    setError("");
    try {
      const before = encodeURIComponent(messages[0].createdAt);
      const data = await api(`/admin/conversations/${activeConversationId}/messages?before=${before}`);
      setMessages((current) => [...data.messages.filter((message) => !current.some((item) => item.id === message.id)), ...current]);
      setHasOlderMessages(data.messages.length === 100);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingOlder(false);
    }
  };

  const toggleSuspend = async (person) => {
    setBusyId(person.id);
    setError("");
    try {
      const data = await api(`/admin/users/${person.id}`, { method: "PATCH", body: { suspended: !person.suspended } });
      setUsers((list) => list.map((item) => (
        item.id === person.id
          ? { ...item, suspended: data.user.suspended, online: data.user.suspended ? false : item.online }
          : item
      )));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId("");
    }
  };

  const visibleUsers = useMemo(() => {
    const normalized = query.trim().replace(/^@/, "").toLowerCase();
    if (!normalized) return users;
    return users.filter((person) => (
      person.username.includes(normalized) ||
      person.chattedWith.some((partner) => partner.username.includes(normalized))
    ));
  }, [query, users]);

  return (
    <div className="admin-shell">
      <header className="admin-top">
        <div className="brand"><ShieldCheck size={22} /> Admin dashboard</div>
        <div className="tabs">
          <button type="button" className={tab === "accounts" ? "active" : ""} onClick={() => setTab("accounts")}><Users size={15} /> Accounts</button>
          <button type="button" className={tab === "messages" ? "active" : ""} onClick={() => setTab("messages")}><MessageCircle size={15} /> Messages</button>
        </div>
        <div className="head-actions">
          <Link to="/chat" className="btn small ghost">My chats</Link>
          <span className="muted hide-mobile">@{user.username}</span>
          <ThemeToggle />
          <button className="icon-btn" onClick={logout} title="Log out"><LogOut size={19} /></button>
        </div>
      </header>

      {error && <div className="alert admin-alert">{error}</div>}

      <div className="stat-row admin-stat-row">
        {[["Accounts", stats?.users], ["Conversations", stats?.conversations], ["Online now", stats?.online]].map(([label, value]) => (
          <div className="stat" key={label}><span>{label}</span><strong>{value ?? "—"}</strong></div>
        ))}
      </div>

      {tab === "accounts" ? (
        <>
          <div className="admin-users-toolbar">
            <div>
              <h1>All accounts</h1>
              <p className="muted">Account list and chat partners.</p>
            </div>
            <label className="admin-search">
              <Search size={16} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter accounts or chat partners" />
            </label>
          </div>

          {loading ? <div className="center-inline"><Spinner /></div> : (
            <div className="users-table-wrap">
              <table className="users-table">
                <thead><tr><th>Account</th><th>Role</th><th>Status</th><th>Joined</th><th>Chatted with</th><th /></tr></thead>
                <tbody>
                  {visibleUsers.map((person) => (
                    <tr key={person.id}>
                      <td><span className="user-cell"><Avatar name={person.username} size={28} /> @{person.username}</span></td>
                      <td>{person.role}</td>
                      <td>
                        {person.suspended ? <span className="pill red">suspended</span> : person.online ? <span className="pill green">online</span> : <span className="pill">offline</span>}
                      </td>
                      <td>{new Date(person.createdAt).toLocaleDateString()}</td>
                      <td>
                        <div className="chat-partners">
                          {person.chattedWith.length
                            ? person.chattedWith.map((partner) => <span className="partner-chip" key={partner.id}>@{partner.username}</span>)
                            : <span className="muted">No chats yet</span>}
                        </div>
                      </td>
                      <td className="right">
                        {person.role !== "admin" && (
                          <button
                            className={`btn small ${person.suspended ? "primary" : "ghost"}`}
                            disabled={busyId === person.id}
                            onClick={() => toggleSuspend(person)}
                          >
                            {person.suspended ? "Reactivate" : "Suspend"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {visibleUsers.length === 0 && (
                    <tr><td colSpan={6} className="muted">{users.length ? "No accounts match your filter." : "No accounts found."}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="admin-users-toolbar">
            <div>
              <h1>Private account messages</h1>
              <p className="muted">Read-only administrator audit view. Other accounts cannot access these conversations.</p>
            </div>
            <label className="admin-search">
              <Search size={16} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter conversations" />
            </label>
          </div>
          <div className="admin-message-layout">
            <aside className="admin-conversation-list">
              {conversations.filter((conversation) => conversation.members.some((member) => member.username.toLowerCase().includes(query.trim().replace(/^@/, "").toLowerCase()))).map((conversation) => (
                <button
                  type="button"
                  key={conversation.id}
                  className={`admin-conversation-row ${conversation.id === activeConversationId ? "active" : ""}`}
                  onClick={() => setActiveConversationId(conversation.id)}
                >
                  <strong>{conversation.members.map((member) => `@${member.username}`).join(" ↔ ")}</strong>
                  <span>{new Date(conversation.lastMessageAt).toLocaleString()}</span>
                </button>
              ))}
              {conversations.length === 0 && <p className="empty muted">No private conversations yet.</p>}
            </aside>
            <section className="admin-message-pane">
              {!activeConversationId ? <div className="empty big"><MessageCircle size={36} /><p>Select a conversation.</p></div> : (
                <>
                  <header className="admin-message-heading">
                    <strong>{conversations.find((item) => item.id === activeConversationId)?.members.map((member) => `@${member.username}`).join(" ↔ ")}</strong>
                    <span className="muted">Read-only audit</span>
                  </header>
                  <div className="admin-message-history">
                    {hasOlderMessages && <button className="btn small ghost" onClick={loadOlderMessages} disabled={loadingOlder}>{loadingOlder ? <Spinner /> : "Load older messages"}</button>}
                    {loadingMessages ? <div className="center-inline"><Spinner /></div> : messages.map((message) => {
                      const conversation = conversations.find((item) => item.id === activeConversationId);
                      const sender = conversation?.members.find((member) => member.id === message.senderId);
                      return (
                        <article className="admin-message" key={message.id}>
                          <header><strong>@{sender?.username || "deleted_user"}</strong><time>{new Date(message.createdAt).toLocaleString()}</time></header>
                          <p>{message.text}</p>
                        </article>
                      );
                    })}
                    {!loadingMessages && messages.length === 0 && <p className="empty muted">No messages in this conversation.</p>}
                  </div>
                </>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
