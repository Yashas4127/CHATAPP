import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Code2, Copy, FolderPlus, Link2, MessageCircle, Users } from "lucide-react";
import { api } from "../api.js";
import { useAuth } from "../AuthContext.jsx";
import { ThemeToggle } from "../ThemeContext.jsx";
import { Spinner } from "../components.jsx";

const ROOM_CODE = /^(?:CLP-(?:[A-Z0-9]|[A-Z0-9][A-Z0-9-]{0,22}[A-Z0-9])|GRP-[A-F0-9]{24})$/i;

function inviteFrom(value) {
  try {
    const url = new URL(value);
    return {
      code: url.pathname.match(/\/(?:clip\/?|group\/|gp\/?)([^/?#]+)/i)?.[1] || "",
      invitation: url.searchParams.get("invite") || ""
    };
  } catch {
    return { code: value.trim(), invitation: "" };
  }
}

export default function HomePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [roomValue, setRoomValue] = useState("");
  const [groupName, setGroupName] = useState("");
  const [displayName, setDisplayName] = useState(user?.username || "Guest");
  const [groupDescription, setGroupDescription] = useState("");
  const [joinError, setJoinError] = useState("");
  const [groupError, setGroupError] = useState("");
  const [busy, setBusy] = useState(false);

  const openRoom = (event) => {
    event.preventDefault();
    const parsed = inviteFrom(roomValue);
    const rawCode = parsed.code.toUpperCase().trim();
    const enteredCode = rawCode.startsWith("GP") && rawCode.length === 26
      ? `GRP-${rawCode.slice(2)}`
      : rawCode;
    const code = enteredCode.startsWith("CLP-") || enteredCode.startsWith("GRP-")
      ? enteredCode
      : (enteredCode.length === 24 ? `GRP-${enteredCode}` : `CLP-${enteredCode}`);
    if (!ROOM_CODE.test(code)) {
      setJoinError("Enter a valid clipboard or group code, or paste an invitation link.");
      return;
    }
    setJoinError("");
    if (code.startsWith("CLP-")) navigate(`/clip/${code}`);
    else navigate(`/gp${code.slice(4)}${parsed.invitation ? `?invite=${encodeURIComponent(parsed.invitation)}` : ""}`);
  };

  const createGroup = async (event) => {
    event.preventDefault();
    setBusy(true);
    setGroupError("");
    try {
      const { group, inviteUrl } = await api("/groups", {
        method: "POST",
        body: { name: groupName, description: groupDescription, displayName }
      });
      const invite = new URL(inviteUrl).searchParams.get("invite");
      navigate(`/gp${group.code.slice(4)}?invite=${encodeURIComponent(invite)}`);
    } catch (err) {
      setGroupError(err.message);
      setBusy(false);
    }
  };


  return (
    <div className="landing-page">
      <header className="landing-nav">
        <Link to="/" className="brand"><MessageCircle size={22} /> WebChat</Link>
        <nav>
          <Link to="/clipboard/new">Clipboard</Link>
          {user ? <Link className="btn small primary" to={user.role === "admin" ? "/admin" : "/chat"}>{user.role === "admin" ? "Admin" : "My chats"} <ArrowRight size={14} /></Link> : (
            <>
              <Link to="/login">Sign in</Link>
              <Link className="btn small primary" to="/register">Create account</Link>
            </>
          )}
          <ThemeToggle />
        </nav>
      </header>

      <main className="landing-content">
        <section className="landing-hero">
          <span className="landing-kicker">COLLABORATE WITHOUT FRICTION</span>
          <h1>One link. A shared space to <span>make things together.</span></h1>
          <p>Create a live clipboard for quick notes and code, or start a group workspace with shared editing and room chat. Guests can join without creating an account.</p>
          <div className="landing-ctas">
            <Link to="/clipboard/new" className="btn primary"><Copy size={17} /> Create a Clipboard</Link>
            <a href="#create-group" className="btn ghost"><FolderPlus size={17} /> Create a Group</a>
          </div>
          <div className="landing-points"><span><Code2 size={15} /> Live collaborative editing</span><span><Users size={15} /> Join as a guest</span><span><Link2 size={15} /> Share with a link</span></div>
        </section>

        <section className="landing-tools" aria-label="Create or join a collaborative space">
          <article className="landing-card landing-join">
            <div className="clipboard-mark"><Link2 size={21} /></div>
            <p className="clipboard-eyebrow">ALREADY HAVE A LINK?</p>
            <h2>Join with a code</h2>
            <p className="muted">Open a clipboard or paste a group invitation.</p>
            <form className="landing-form" onSubmit={openRoom}>
              <label htmlFor="room-code">Code or invitation link</label>
              <input id="room-code" value={roomValue} onChange={(event) => { setRoomValue(event.target.value); setJoinError(""); }} placeholder="clip15 or group invitation link" autoCapitalize="characters" />
              {joinError && <div className="alert">{joinError}</div>}
              <button className="btn primary wide" disabled={!roomValue.trim()}>Join workspace <ArrowRight size={16} /></button>
            </form>
          </article>

          <article className="landing-card" id="create-group">
            <div className="clipboard-mark"><Users size={21} /></div>
            <p className="clipboard-eyebrow">WORK TOGETHER</p>
            <h2>Create a Group</h2>
            <p className="muted">Invite people to a shared editor and an independent room chat.</p>
            <form className="landing-form" onSubmit={createGroup}>
              <label htmlFor="group-name">Group name</label>
              <input id="group-name" value={groupName} onChange={(event) => { setGroupName(event.target.value); setGroupError(""); }} maxLength={64} required placeholder="e.g. Weekend project" />
              <label htmlFor="group-description">Description <span className="muted">(optional)</span></label>
              <input id="group-description" value={groupDescription} onChange={(event) => setGroupDescription(event.target.value)} maxLength={500} placeholder="What are you working on?" />
              <label htmlFor="group-display-name">Your display name</label>
              <input id="group-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={32} required />
              {groupError && <div className="alert">{groupError}</div>}
              <button className="btn primary wide" disabled={busy}>{busy ? <Spinner /> : <><FolderPlus size={16} /> Create a Group</>}</button>
            </form>
          </article>
        </section>
        <p className="landing-footnote">No account needed for shared clipboards or groups. <Link to="/register">Create an account</Link> for private one-to-one chat.</p>
      </main>
    </div>
  );
}
