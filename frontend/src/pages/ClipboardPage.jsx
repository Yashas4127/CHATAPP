import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Editor from "@monaco-editor/react";
import { MonacoBinding } from "y-monaco";
import * as Y from "yjs";
import {
  ArrowLeft, Check, Clock3, Copy, ExternalLink, Link2, LockKeyhole,
  MessageCircle, Save, Shield, Trash2, Users, X
} from "lucide-react";
import { api } from "../api.js";
import RoomChat from "../components/RoomChat.jsx";
import { createClipboardCollaboration } from "../collaboration.js";
import { monaco } from "../monaco.js";
import { useAuth } from "../AuthContext.jsx";
import { Spinner } from "../components.jsx";
import { ThemeToggle, useTheme } from "../ThemeContext.jsx";

const EXPIRATIONS = [
  ["10m", "10 minutes"],
  ["1h", "1 hour"],
  ["24h", "24 hours"],
  ["7d", "7 days"],
  ["never", "Never"]
];
const LANGUAGES = [
  ["plaintext", "Text"],
  ["c", "C"],
  ["cpp", "C++"],
  ["java", "Java"],
  ["python", "Python"],
  ["javascript", "JavaScript"],
  ["go", "Go"],
];
const DEFAULT_LANGUAGE = "plaintext";
const COLORS = ["#8B5CF6", "#22C55E", "#0EA5E9", "#F97316", "#EC4899", "#EAB308", "#14B8A6"];
const CODE_PATTERN = /^CLP-(?:[A-Z0-9]|[A-Z0-9][A-Z0-9-]{0,22}[A-Z0-9])$/i;
const CREATE_CODE_PATTERN = /^CLP-(?:[A-Z0-9]|[A-Z0-9][A-Z0-9-]{0,12}[A-Z0-9])$/i;

function expirationLabel(value) {
  return EXPIRATIONS.find(([key]) => key === value)?.[1] || value;
}

function colorFor(name) {
  const hash = [...(name || "Guest")].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return COLORS[hash % COLORS.length];
}

function useCopy() {
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const copyText = useCallback(async (value, label) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable in this browser.");
      await navigator.clipboard.writeText(value);
      setNotice(`${label} copied.`);
      setError("");
    } catch (err) {
      setError(err.message || "Could not copy. Select the text and copy it manually.");
    }
  }, []);
  return { notice, setNotice, error, setError, copyText };
}

export function ClipboardHome() {
  const navigate = useNavigate();
  const [permission, setPermission] = useState("editable");
  const [expiration, setExpiration] = useState("24h");
  const [clipboardCode, setClipboardCode] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const createClipboard = async (event) => {
    event.preventDefault();
    const body = { permission, expiration };
    const enteredCode = clipboardCode.trim().toUpperCase();
    if (enteredCode) {
      const normalizedCode = enteredCode.startsWith("CLP-") ? enteredCode : `CLP-${enteredCode}`;
      if (!CREATE_CODE_PATTERN.test(normalizedCode)) {
        setError("Custom code must have 1-12 letters or numbers (hyphens allowed inside).");
        return;
      }
      body.code = normalizedCode;
    }

    setBusy(true);
    setError("");
    try {
      const data = await api("/clipboards", { method: "POST", body });
      navigate(`/clip/${data.clipboard.code}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const openClipboard = (event) => {
    event.preventDefault();
    const enteredCode = code.trim().toUpperCase();
    const normalized = enteredCode.startsWith("CLP-") ? enteredCode : `CLP-${enteredCode}`;
    if (!CODE_PATTERN.test(normalized)) {
      setError("Enter the clipboard code (e.g. CLP-82X91 or 82X91).");
      return;
    }
    navigate(`/clip/${normalized}`);
  };

  return (
    <div className="clipboard-page">
      <main className="clipboard-home">
        <div className="clipboard-home-top">
          <Link to="/" className="clipboard-back"><ArrowLeft size={16} /> Back home</Link>
          <ThemeToggle />
        </div>
        <section className="clipboard-home-card">
          <div className="clipboard-mark"><Copy size={23} /></div>
          <p className="clipboard-eyebrow">SHARE A NOTE OR SNIPPET</p>
          <h1>Create a Clipboard</h1>
          <p className="muted">Share text or code instantly. Guests can open the link without an account.</p>

          {error && <div className="alert">{error}</div>}

          <form className="clipboard-create-form" onSubmit={createClipboard}>
            <label>
              Choose clipboard code <span className="muted">(optional)</span>
              <input
                value={clipboardCode}
                onChange={(event) => { setClipboardCode(event.target.value.toUpperCase()); setError(""); }}
                maxLength={16}
                placeholder="Leave blank for unique random code (e.g. CLP-82X91)"
                autoCapitalize="characters"
                spellCheck="false"
              />
              <span className="muted">Leave blank to auto-generate a random code like CLP-82X91, or provide a custom short code.</span>
            </label>
            <label>
              Visitor access
              <select value={permission} onChange={(event) => setPermission(event.target.value)}>
                <option value="readOnly">Read Only — visitors can view</option>
                <option value="editable">Editable — visitors can make changes</option>
              </select>
            </label>
            <label>
              Automatically delete after
              <select value={expiration} onChange={(event) => setExpiration(event.target.value)}>
                {EXPIRATIONS.map(([key, label]) => <option value={key} key={key}>{label}</option>)}
              </select>
            </label>
            <button className="btn primary wide" disabled={busy}>
              {busy ? <Spinner /> : <><Copy size={16} /> Create Clipboard</>}
            </button>
          </form>

          <div className="clipboard-divider"><span>OR OPEN AN EXISTING CLIPBOARD</span></div>
          <form className="clipboard-join-form" onSubmit={openClipboard}>
            <input
              value={code}
              onChange={(event) => { setCode(event.target.value); setError(""); }}
              placeholder="Enter code (e.g. CLP-82X91 or 82X91)"
              maxLength={28}
              autoCapitalize="characters"
              spellCheck="false"
              aria-label="Clipboard code"
            />
            <button className="btn ghost" disabled={!code.trim()}>Open</button>
          </form>
        </section>
      </main>
    </div>
  );
}

export function ClipboardEditor() {
  const { code: routeCode = "" } = useParams();
  const enteredCode = (routeCode || "").toUpperCase().trim();
  const code = enteredCode.startsWith("CLP-") ? enteredCode : `CLP-${enteredCode}`;
  const shortCode = code;
  const { user } = useAuth();
  const { theme } = useTheme();
  const [clipboard, setClipboard] = useState(null);
  const [identity, setIdentity] = useState(() => {
    const raw = (routeCode || "").toUpperCase().trim();
    const c = raw.startsWith("CLP-") ? raw : `CLP-${raw}`;
    const stored = sessionStorage.getItem(`wc_clip_guest_${c}`);
    return { code: c, name: stored || `Guest ${Math.floor(1000 + Math.random() * 9000)}` };
  });
  const [language, setLanguage] = useState(DEFAULT_LANGUAGE);
  const [expiration, setExpiration] = useState("24h");
  const [participants, setParticipants] = useState([]);
  const [realtime, setRealtime] = useState("connecting");
  const [lastSaved, setLastSaved] = useState(null);
  const [loading, setLoading] = useState(true);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [provider, setProvider] = useState(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [characterCount, setCharacterCount] = useState(0);
  const { notice, setNotice, error, setError, copyText } = useCopy();
  const navigate = useNavigate();
  const doc = useMemo(() => new Y.Doc(), [code]);
  const clipboardRef = useRef(null);
  const providerRef = useRef(null);
  const bindingRef = useRef(null);
  const editorRef = useRef(null);
  const settingsBaselineRef = useRef({ permission: "editable", expiration: "24h" });
  const languageMap = doc.getMap("meta");

  useEffect(() => {
    const onLanguage = () => {
      const next = languageMap.get("language");
      const selected = LANGUAGES.some(([key]) => key === next) ? next : DEFAULT_LANGUAGE;
      setLanguage(selected);
      const model = editorRef.current?.getModel();
      if (model) monaco.editor.setModelLanguage(model, selected);
    };
    languageMap.observe(onLanguage);
    const text = doc.getText("content");
    const onTextChange = () => setCharacterCount(text.length);
    text.observe(onTextChange);
    onTextChange();
    return () => {
      languageMap.unobserve(onLanguage);
      text.unobserve(onTextChange);
    };
  }, [doc, languageMap]);

  useEffect(() => {
    const timer = window.setTimeout(() => doc.destroy(), 0);
    return () => window.clearTimeout(timer);
  }, [doc]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    api(`/clipboards/${encodeURIComponent(code)}`)
      .then(({ clipboard: next }) => {
        if (!active) return;
        clipboardRef.current = next;
        setClipboard(next);
        setExpiration(next.expiration);
        settingsBaselineRef.current = { permission: next.permission, expiration: next.expiration };
        const storedName = sessionStorage.getItem(`wc_clip_guest_${code}`);
        const name = storedName || (next.isCreator ? (user?.username || "Creator") : (user?.username || `Guest ${Math.floor(1000 + Math.random() * 9000)}`));
        sessionStorage.setItem(`wc_clip_guest_${code}`, name);
        setIdentity({ code, name });
      })
      .catch((err) => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [code, setError, user?.username]);

  const displayName = identity.name || `Guest ${Math.floor(1000 + Math.random() * 9000)}`;
  const color = colorFor(displayName);

  useEffect(() => {
    if (!clipboard || !displayName) return undefined;
    const nextProvider = createClipboardCollaboration({ code, displayName, color, doc });
    providerRef.current = nextProvider;
    setProvider(nextProvider);
    const unsubscribers = [
      nextProvider.on("status", setRealtime),
      nextProvider.on("participants", setParticipants),
      nextProvider.on("error", setError),
      nextProvider.on("lastSaved", setLastSaved),
      nextProvider.on("settings", (settings) => {
        const next = { ...clipboardRef.current, ...settings };
        clipboardRef.current = next;
        settingsBaselineRef.current = { permission: next.permission, expiration: next.expiration };
        setClipboard(next);
        setExpiration(next.expiration);
      }),
      nextProvider.on("deleted", (deleted) => {
        if (!deleted) return;
        clipboardRef.current = null;
        setClipboard(null);
        setError("This clipboard was deleted by its creator.");
      })
    ];
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      nextProvider.destroy();
      if (providerRef.current === nextProvider) providerRef.current = null;
      setProvider(null);
    };
  }, [clipboard?.code, code, color, displayName, doc, setError]);

  const shareUrl = useMemo(() => (
    clipboard ? `${window.location.origin}/clip/${clipboard.code}` : ""
  ), [clipboard?.code]);

  useEffect(() => {
    const style = document.createElement("style");
    const escapeCss = (value) => value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/[\n\r]/g, " ");
    style.textContent = participants.filter((person) => Number.isSafeInteger(person.clientId)).map((person) => (
      `.yRemoteSelection-${person.clientId}{background-color:${person.color}44!important}` +
      `.yRemoteSelectionHead-${person.clientId}{border-color:${person.color}!important}` +
      `.yRemoteSelectionHead-${person.clientId}::after{content:"${escapeCss(person.name)}";background:${person.color}}`
    )).join("\n");
    document.head.append(style);
    return () => style.remove();
  }, [participants]);

  useEffect(() => () => {
    bindingRef.current?.destroy();
    bindingRef.current = null;
  }, [doc]);

  const attachBinding = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || !providerRef.current) return;

    bindingRef.current?.destroy();
    bindingRef.current = null;

    const model = editor.getModel();
    if (!model) return;

    const storedLanguage = languageMap.get("language");
    const selected = LANGUAGES.some(([key]) => key === storedLanguage) ? storedLanguage : DEFAULT_LANGUAGE;
    monaco.editor.setModelLanguage(model, selected);

    const nextBinding = new MonacoBinding(
      doc.getText("content"),
      model,
      new Set([editor]),
      providerRef.current.awareness
    );
    bindingRef.current = nextBinding;
  }, [doc, languageMap]);

  const onEditorMount = useCallback((editor) => {
    editorRef.current = editor;
    attachBinding();
  }, [attachBinding]);

  useEffect(() => {
    if (editorRef.current && provider) {
      attachBinding();
    }
  }, [provider, attachBinding]);

  const updatePermission = (value) => {
    const next = { ...clipboardRef.current, permission: value };
    clipboardRef.current = next;
    setClipboard(next);
  };

  const saveSettings = async () => {
    if (!clipboard?.isCreator || settingsBusy) return;
    const changes = {};
    if (clipboard.permission !== settingsBaselineRef.current.permission) changes.permission = clipboard.permission;
    if (expiration !== settingsBaselineRef.current.expiration) changes.expiration = expiration;
    if (!Object.keys(changes).length) return;
    setSettingsBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await api(`/clipboards/${clipboard.code}/settings`, { method: "PATCH", body: changes });
      clipboardRef.current = data.clipboard;
      settingsBaselineRef.current = { permission: data.clipboard.permission, expiration: data.clipboard.expiration };
      setClipboard(data.clipboard);
      setExpiration(data.clipboard.expiration);
      setNotice("Clipboard access settings updated.");
    } catch (err) {
      setError(err.message);
    } finally {
      setSettingsBusy(false);
    }
  };

  const saveContentNow = async () => {
    if (!canEdit || saveBusy) return;
    setSaveBusy(true);
    setError("");
    setNotice("");
    try {
      const content = doc.getText("content").toString();
      const currentLanguage = languageMap.get("language") || language;
      await api(`/clipboards/${clipboard.code}`, {
        method: "PATCH",
        body: { content, language: currentLanguage }
      });
      provider?.saveNow?.();
      setLastSaved(new Date().toISOString());
      setNotice("Content saved successfully.");
    } catch (err) {
      setError(err.message);
    } finally {
      setSaveBusy(false);
    }
  };

  const deleteClipboard = async () => {
    if (!clipboard?.isCreator || !window.confirm("Delete this clipboard for everyone? This cannot be undone.")) return;
    try {
      await api(`/clipboards/${clipboard.code}`, { method: "DELETE" });
      navigate("/clipboard");
    } catch (err) {
      setError(err.message);
    }
  };

  const changeLanguage = (value) => {
    setLanguage(value);
    languageMap.set("language", value);
  };

  const canEdit = Boolean(clipboard && (clipboard.isCreator || clipboard.permission === "editable"));
  const activeNames = participants.filter((person) => person.id !== provider?.socket?.id);

  return (
    <div className="clipboard-page workspace-page">
      <main className="clipboard-shell workspace-shell">
        <header className="clipboard-topbar">
          <Link to="/clipboard" className="clipboard-back"><ArrowLeft size={16} /> Clipboards</Link>
          <div className="group-top-actions">
            <span className={`realtime-status ${realtime}`}><i /> {realtime === "connected" ? "Live sync" : realtime === "connecting" ? "Connecting…" : "Reconnecting…"}</span>
            <button className="btn small ghost" onClick={() => setChatOpen((open) => !open)} disabled={!clipboard || !provider} aria-expanded={chatOpen}><MessageCircle size={15} /> Chat</button>
            <ThemeToggle />
          </div>
        </header>

        {loading ? (
          <div className="clipboard-loading"><Spinner /> Loading clipboard…</div>
        ) : !clipboard ? (
          <section className="clipboard-home-card clipboard-error-card">
            <div className="clipboard-mark"><X size={23} /></div>
            <h1>Clipboard unavailable</h1>
            <p className="muted">{error || "This clipboard may have expired or been deleted."}</p>
            <Link to="/clipboard" className="btn primary">Create or open a clipboard</Link>
          </section>
        ) : (
          <section className="clipboard-card clipboard-workspace-card">
            <div className="clipboard-editor-heading">
              <div>
                <p className="clipboard-eyebrow">{clipboard.isCreator ? "YOUR CLIPBOARD" : "SHARED CLIPBOARD"}</p>
                <h1>Clipboard <code>{shortCode}</code></h1>
              </div>
              <div className="clipboard-badges">
                <span className={clipboard.permission === "editable" ? "clipboard-badge editable" : "clipboard-badge"}>
                  {clipboard.permission === "editable" ? <Users size={14} /> : <LockKeyhole size={14} />}
                  {clipboard.permission === "editable" ? "Editable" : "Read only"}
                </span>
                <span className="clipboard-badge"><Clock3 size={14} /> {clipboard.expiresAt ? `Expires ${new Date(clipboard.expiresAt).toLocaleString()}` : "Never expires"}</span>
              </div>
            </div>

            <div className="clipboard-share-row">
              <label className="clipboard-share-link">
                <Link2 size={16} />
                <input value={shareUrl} readOnly aria-label="Shareable clipboard URL" onFocus={(event) => event.target.select()} />
              </label>
              <button className="btn ghost" onClick={() => copyText(shareUrl, "Share link")}><ExternalLink size={15} /> Copy link</button>
              <button className="btn ghost" onClick={() => copyText(shortCode, "Clipboard code")}><Copy size={15} /> Copy code</button>
            </div>

            {clipboard.isCreator && (
              <div className="clipboard-settings">
                <label>
                  Visitor access
                  <select value={clipboard.permission} onChange={(event) => updatePermission(event.target.value)}>
                    <option value="readOnly">Read Only</option>
                    <option value="editable">Editable</option>
                  </select>
                </label>
                <label>
                  Extend expiration
                  <select value={expiration} onChange={(event) => setExpiration(event.target.value)}>
                    {EXPIRATIONS.map(([key, label]) => <option value={key} key={key}>{label}</option>)}
                  </select>
                </label>
                <button className="btn ghost" onClick={saveSettings} disabled={settingsBusy}>
                  {settingsBusy ? <Spinner /> : <><Shield size={15} /> Save access settings</>}
                </button>
                <button className="btn danger" onClick={deleteClipboard}><Trash2 size={15} /> Delete</button>
              </div>
            )}

            <div className="clipboard-editor-toolbar">
              <label className="clipboard-language">
                Language
                <select value={language} onChange={(event) => changeLanguage(event.target.value)} disabled={!canEdit}>
                  {LANGUAGES.map(([key, label]) => <option value={key} key={key}>{label}</option>)}
                </select>
              </label>
              <span className="clipboard-editor-meta">{characterCount.toLocaleString()} characters</span>
              <span className="clipboard-editor-meta">{lastSaved ? `Saved ${new Date(lastSaved).toLocaleTimeString()}` : "Changes sync automatically"}</span>
              <div className="clipboard-participants" aria-label="Active collaborators">
                {activeNames.slice(0, 5).map((person) => (
                  <span className="participant-avatar" key={person.id} style={{ "--person-color": person.color }} title={person.name}>
                    {person.name.charAt(0).toUpperCase()}
                  </span>
                ))}
                <span className="clipboard-editor-meta"><Users size={14} /> {participants.length} active</span>
              </div>
            </div>

            {error && <div className="alert clipboard-alert">{error}</div>}
            {notice && <div className="clipboard-notice"><Check size={15} /> {notice}</div>}
            {realtime !== "connected" && <p className="clipboard-live-hint">Live updates are paused while this page reconnects.</p>}

            <div className={`clipboard-monaco-area ${!canEdit ? "readonly" : ""}`}>
              {provider && (
                <Editor
                  height="100%"
                  defaultLanguage={language}
                  defaultValue=""
                  language={language}
                  theme={theme === "dark" ? "vs-dark" : "light"}
                  options={{
                    automaticLayout: true,
                    minimap: { enabled: false },
                    readOnly: !canEdit,
                    fontSize: 14,
                    lineNumbers: "on",
                    scrollBeyondLastLine: false,
                    wordWrap: "on",
                    padding: { top: 16, bottom: 16 }
                  }}
                  onMount={onEditorMount}
                />
              )}
              {!provider && <div className="clipboard-editor-placeholder"><Spinner /> Connecting editor…</div>}
            </div>

            <footer className="clipboard-actions">
              <span className="clipboard-owner-note">
                {clipboard.isCreator ? "You control this clipboard." : clipboard.permission === "editable" ? "Anyone with the link can edit." : "Visitors can only view this clipboard."}
                {clipboard.isCreator && ` Expires: ${expirationLabel(clipboard.expiration)}.`}
                {" "}Editing as @{displayName}.
              </span>
              <div>
                <button className="btn ghost" onClick={() => copyText(doc.getText("content").toString(), "Content")} disabled={!doc.getText("content").length}>
                  <Copy size={15} /> Copy content
                </button>
                {canEdit && (
                  <button className="btn ghost" onClick={() => doc.getText("content").delete(0, doc.getText("content").length)} disabled={!doc.getText("content").length}>
                    <Trash2 size={15} /> Clear content
                  </button>
                )}
                {canEdit && (
                  <button className="btn primary" onClick={saveContentNow} disabled={saveBusy}>
                    {saveBusy ? <Spinner /> : <><Save size={15} /> Save content</>}
                  </button>
                )}
              </div>
            </footer>
          </section>
        )}
      </main>
      {chatOpen && clipboard && displayName && provider && (
        <aside className="workspace-chat-drawer" aria-label="Clipboard room chat">
          <button className="icon-btn group-chat-close" onClick={() => setChatOpen(false)} aria-label="Close chat"><X size={18} /></button>
          <RoomChat kind="clipboard" code={code} displayName={displayName} socket={provider.socket} />
        </aside>
      )}
    </div>
  );
}
