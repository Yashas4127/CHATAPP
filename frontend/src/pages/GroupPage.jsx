import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import Editor from "@monaco-editor/react";
import { MonacoBinding } from "y-monaco";
import * as Y from "yjs";
import {
  ArrowLeft, Check, ChevronDown, ChevronUp, Clock, Copy, Edit2, ExternalLink,
  FileCode, FilePlus, FileText, Folder, History, Maximize2, MessageCircle,
  Minimize2, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen,
  Play, Save, Settings2, Terminal, Trash2, UserMinus, Users, X
} from "lucide-react";
import { api } from "../api.js";
import RoomChat from "../components/RoomChat.jsx";
import { Spinner } from "../components.jsx";
import { createRoomCollaboration } from "../collaboration.js";
import { monaco } from "../monaco.js";
import { ThemeToggle, useTheme } from "../ThemeContext.jsx";

const LANGUAGES = [
  ["python", "Python", ".py"],
  ["javascript", "JavaScript", ".js"],
  ["c", "C", ".c"],
  ["cpp", "C++", ".cpp"],
  ["java", "Java", ".java"],
  ["go", "Go", ".go"],
  ["plaintext", "Plain Text", ".txt"]
];
const DEFAULT_LANGUAGE = "python";
const COLORS = ["#8B5CF6", "#22C55E", "#0EA5E9", "#F97316", "#EC4899", "#EAB308", "#14B8A6"];
const colorFor = (name) => COLORS[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % COLORS.length];

function detectLanguage(fileName) {
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  const match = LANGUAGES.find(([, , extension]) => extension === ext);
  return match ? match[0] : "plaintext";
}

export default function GroupPage() {
  const { code: routeCode = "" } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { theme } = useTheme();

  // Normalize group code from gpXXXX or GRP-XXXX
  const code = useMemo(() => {
    const raw = (routeCode || "").toUpperCase().trim();
    if (raw.startsWith("GRP-")) return raw;
    if (raw.startsWith("GP") && raw.length === 26) return `GRP-${raw.slice(2)}`;
    if (raw.length === 24) return `GRP-${raw}`;
    return raw.startsWith("GRP-") ? raw : `GRP-${raw}`;
  }, [routeCode]);

  const [group, setGroup] = useState(null);
  const [requestedName, setRequestedName] = useState(() => `Guest ${Math.floor(1000 + Math.random() * 9000)}`);
  const [invitation, setInvitation] = useState(searchParams.get("invite") || "");
  const [provider, setProvider] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [realtime, setRealtime] = useState("connecting");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [lastSaved, setLastSaved] = useState(null);

  // Layout panels state
  const [filesPanelOpen, setFilesPanelOpen] = useState(true);
  const [membersPanelOpen, setMembersPanelOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [terminalTab, setTerminalTab] = useState("output"); // "output" | "stdin" | "history"
  const [terminalMaximized, setTerminalMaximized] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Multi-file workspace state
  const [files, setFiles] = useState([]);
  const [activeFileId, setActiveFileId] = useState("");
  const [newFileModal, setNewFileModal] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [renameModal, setRenameModal] = useState(null);
  const [renameValue, setRenameValue] = useState("");

  // Compiler / execution state
  const [stdin, setStdin] = useState("");
  const [executing, setExecuting] = useState(false);
  const [executionBanner, setExecutionBanner] = useState("");
  const [currentResult, setCurrentResult] = useState(null);
  const [executionHistory, setExecutionHistory] = useState([]);

  const doc = useMemo(() => new Y.Doc(), [code]);
  const metaMap = doc.getMap("meta");
  const bindingRef = useRef(null);
  const editorRef = useRef(null);
  const providerRef = useRef(null);

  const activeFile = useMemo(() => {
    return files.find((f) => f.id === activeFileId) || files[0] || null;
  }, [files, activeFileId]);

  // Load group details
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    api(`/groups/${encodeURIComponent(code)}`)
      .then(({ group: next }) => {
        if (!active) return;
        setGroup(next);
        if (next.displayName) setRequestedName(next.displayName);
      })
      .catch((err) => active && setError(err.message))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [code]);

  // Load workspace files & execution history once member joins
  const loadFilesAndHistory = useCallback(async () => {
    try {
      const [filesRes, historyRes] = await Promise.all([
        api(`/groups/${encodeURIComponent(code)}/files`),
        api(`/groups/${encodeURIComponent(code)}/executions`)
      ]);
      setFiles(filesRes.files || []);
      if (filesRes.files?.length && !activeFileId) {
        setActiveFileId(filesRes.files[0].id);
      }
      setExecutionHistory(historyRes.executions || []);
      if (historyRes.executions?.length && !currentResult) {
        setCurrentResult(historyRes.executions[0]);
      }
    } catch (err) {
      console.warn("Could not load group files or history:", err.message);
    }
  }, [code, activeFileId, currentResult]);

  useEffect(() => {
    if (group?.isMember) {
      loadFilesAndHistory();
    }
  }, [group?.isMember, loadFilesAndHistory]);

  // Clean up Y.Doc on unmount
  useEffect(() => {
    const timer = window.setTimeout(() => doc.destroy(), 0);
    return () => window.clearTimeout(timer);
  }, [doc]);

  const displayName = group?.displayName || "";
  const color = colorFor(displayName || requestedName);

  // Setup Socket.IO & Yjs Room Collaboration
  useEffect(() => {
    if (!group?.isMember || !displayName) return undefined;
    const nextProvider = createRoomCollaboration({ kind: "group", code, displayName, color, doc });
    providerRef.current = nextProvider;
    setProvider(nextProvider);

    const unsubscribers = [
      nextProvider.on("participants", setParticipants),
      nextProvider.on("status", setRealtime),
      nextProvider.on("lastSaved", setLastSaved),
      nextProvider.on("error", setError),
      nextProvider.on("settings", (settings) => setGroup((curr) => curr ? { ...curr, ...settings } : curr)),
      nextProvider.on("deleted", (deleted) => {
        if (!deleted) return;
        setGroup(null);
        setError("This group was deleted by its creator.");
      })
    ];

    const socket = nextProvider.socket;

    // Member join/leave real-time updates
    const onMemberJoined = (data) => {
      if (data.members) {
        setGroup((curr) => curr ? { ...curr, members: data.members, memberCount: data.memberCount } : curr);
      } else if (data.displayName) {
        setGroup((curr) => {
          if (!curr) return curr;
          const exists = curr.members?.some((m) => m.displayName === data.displayName);
          if (exists) return curr;
          const newM = { displayName: data.displayName, joinedAt: new Date().toISOString() };
          return { ...curr, members: [...(curr.members || []), newM], memberCount: (curr.members?.length || 0) + 1 };
        });
      }
    };

    const onMemberLeft = (data) => {
      setGroup((curr) => {
        if (!curr) return curr;
        const nextMembers = (curr.members || []).filter((m) => m.displayName !== data.displayName && m.id !== data.userId);
        return { ...curr, members: nextMembers, memberCount: nextMembers.length };
      });
      if (data.displayName === displayName) {
        setError("You were removed from this group workspace.");
        setGroup((curr) => curr ? { ...curr, isMember: false } : curr);
      }
    };

    // File events
    const onFileCreated = (newFile) => {
      setFiles((curr) => curr.some((f) => f.id === newFile.id) ? curr : [...curr, newFile]);
    };
    const onFileUpdated = (updated) => {
      setFiles((curr) => curr.map((f) => f.id === updated.id ? { ...f, ...updated } : f));
    };
    const onFileDeleted = ({ id }) => {
      setFiles((curr) => {
        const next = curr.filter((f) => f.id !== id);
        if (activeFileId === id && next.length) {
          setActiveFileId(next[0].id);
        }
        return next;
      });
    };

    // Execution events
    const onExecutionStarted = (data) => {
      setExecuting(true);
      setExecutionBanner(`${data.executedBy} is running ${data.fileName || "code"} (${data.language})…`);
      setTerminalOpen(true);
      setTerminalTab("output");
    };
    const onExecutionResult = (res) => {
      setExecuting(false);
      setExecutionBanner("");
      setCurrentResult(res);
      setExecutionHistory((curr) => [res, ...curr.filter((item) => item.id !== res.id)]);
      setTerminalOpen(true);
      setTerminalTab("output");
    };
    const onExecutionError = (err) => {
      setExecuting(false);
      setExecutionBanner("");
      setError(`Execution error by ${err.executedBy}: ${err.error}`);
    };

    socket.on("group:member-joined", onMemberJoined);
    socket.on("group:member-left", onMemberLeft);
    socket.on("collab:file-created", onFileCreated);
    socket.on("collab:file-updated", onFileUpdated);
    socket.on("collab:file-deleted", onFileDeleted);
    socket.on("collab:execution-started", onExecutionStarted);
    socket.on("collab:execution-result", onExecutionResult);
    socket.on("collab:execution-error", onExecutionError);

    return () => {
      unsubscribers.forEach((unsub) => unsub());
      socket.off("group:member-joined", onMemberJoined);
      socket.off("group:member-left", onMemberLeft);
      socket.off("collab:file-created", onFileCreated);
      socket.off("collab:file-updated", onFileUpdated);
      socket.off("collab:file-deleted", onFileDeleted);
      socket.off("collab:execution-started", onExecutionStarted);
      socket.off("collab:execution-result", onExecutionResult);
      socket.off("collab:execution-error", onExecutionError);
      nextProvider.destroy();
      if (providerRef.current === nextProvider) providerRef.current = null;
      setProvider(null);
    };
  }, [group?.code, group?.isMember, code, displayName, color, doc, activeFileId]);

  // Remote cursor styles injection
  useEffect(() => {
    const style = document.createElement("style");
    const escapeCss = (val) => val.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/[\n\r]/g, " ");
    style.textContent = participants
      .filter((p) => Number.isSafeInteger(p.clientId))
      .map((p) => (
        `.yRemoteSelection-${p.clientId}{background-color:${p.color}35!important}` +
        `.yRemoteSelectionHead-${p.clientId}{border-color:${p.color}!important}` +
        `.yRemoteSelectionHead-${p.clientId}::after{content:"${escapeCss(p.name)}";background:${p.color}}`
      )).join("\n");
    document.head.append(style);
    return () => style.remove();
  }, [participants]);

  // Bind active file to Monaco Editor
  const attachBinding = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || !providerRef.current || !activeFile) return;

    bindingRef.current?.destroy();
    bindingRef.current = null;

    const model = editor.getModel();
    if (!model) return;

    const lang = activeFile.language || "plaintext";
    monaco.editor.setModelLanguage(model, lang);

    const yText = doc.getText(`file:${activeFile.id}`);

    bindingRef.current = new MonacoBinding(
      yText,
      model,
      new Set([editor]),
      providerRef.current.awareness
    );
  }, [activeFile, doc]);

  const onEditorMount = useCallback((editor) => {
    editorRef.current = editor;
    attachBinding();
  }, [attachBinding]);

  useEffect(() => {
    if (editorRef.current && providerRef.current && activeFile) {
      attachBinding();
    }
  }, [activeFile?.id, attachBinding]);

  // Keyboard shortcut: Ctrl+Enter / Cmd+Enter runs code
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        runCode();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  // Action: Run Code
  const runCode = async () => {
    if (!activeFile || executing || busy) return;
    const yText = doc.getText(`file:${activeFile.id}`);
    const sourceCode = yText.toString();
    if (!sourceCode.trim()) {
      setError("Cannot run empty code file.");
      return;
    }

    setExecuting(true);
    setError("");
    setNotice("");
    setTerminalOpen(true);
    setTerminalTab("output");

    try {
      const { result } = await api(`/groups/${encodeURIComponent(code)}/execute`, {
        method: "POST",
        body: {
          fileName: activeFile.name,
          language: activeFile.language,
          sourceCode,
          stdin
        }
      });
      setCurrentResult(result);
      setNotice(`Executed ${activeFile.name} (${result.status})`);
    } catch (err) {
      setError(err.message);
    } finally {
      setExecuting(false);
    }
  };

  // Action: Save Current File
  const handleSaveWorkspace = async () => {
    if (!activeFile) return;
    setBusy(true);
    try {
      const yText = doc.getText(`file:${activeFile.id}`);
      const content = yText.toString();
      await api(`/groups/${encodeURIComponent(code)}/files/${activeFile.id}`, {
        method: "PATCH",
        body: { content, language: activeFile.language }
      });
      provider?.saveNow?.();
      setLastSaved(new Date().toISOString());
      setNotice(`Saved ${activeFile.name}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Action: Switch Active File Language
  const changeActiveLanguage = async (newLang) => {
    if (!activeFile) return;
    try {
      await api(`/groups/${encodeURIComponent(code)}/files/${activeFile.id}`, {
        method: "PATCH",
        body: { language: newLang }
      });
      setFiles((curr) => curr.map((f) => f.id === activeFile.id ? { ...f, language: newLang } : f));
      if (editorRef.current) {
        const model = editorRef.current.getModel();
        if (model) monaco.editor.setModelLanguage(model, newLang);
      }
    } catch (err) {
      setError(err.message);
    }
  };

  // Action: Create New File
  const handleCreateFile = async (e) => {
    e.preventDefault();
    const name = newFileName.trim();
    if (!name) return;
    setBusy(true);
    setError("");
    try {
      const detectedLang = detectLanguage(name);
      const { file } = await api(`/groups/${encodeURIComponent(code)}/files`, {
        method: "POST",
        body: { name, language: detectedLang, content: "" }
      });
      setFiles((curr) => [...curr, file]);
      setActiveFileId(file.id);
      setNewFileModal(false);
      setNewFileName("");
      setNotice(`Created ${file.name}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Action: Rename File
  const handleRenameFile = async (e) => {
    e.preventDefault();
    if (!renameModal) return;
    const name = renameValue.trim();
    if (!name) return;
    setBusy(true);
    setError("");
    try {
      const detectedLang = detectLanguage(name);
      const { file } = await api(`/groups/${encodeURIComponent(code)}/files/${renameModal.id}`, {
        method: "PATCH",
        body: { name, language: detectedLang }
      });
      setFiles((curr) => curr.map((f) => f.id === file.id ? { ...f, ...file } : f));
      setRenameModal(null);
      setNotice(`Renamed to ${file.name}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Action: Delete File
  const handleDeleteFile = async (file) => {
    if (files.length <= 1) {
      setError("Cannot delete the only file in the workspace.");
      return;
    }
    if (!window.confirm(`Delete ${file.name}? This will remove it for all collaborators.`)) return;
    setBusy(true);
    try {
      await api(`/groups/${encodeURIComponent(code)}/files/${file.id}`, { method: "DELETE" });
      setFiles((curr) => curr.filter((f) => f.id !== file.id));
      if (activeFileId === file.id) {
        const remaining = files.filter((f) => f.id !== file.id);
        if (remaining.length) setActiveFileId(remaining[0].id);
      }
      setNotice(`Deleted ${file.name}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Action: Join Group
  const join = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api(`/groups/${encodeURIComponent(code)}/join`, {
        method: "POST",
        body: { invitation: invitation.trim(), displayName: requestedName.trim() }
      });
      setGroup(data.group);
      setNotice("You joined the workspace.");
      navigate(`/gp${code.slice(4)}`, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Action: Remove Member (Creator only)
  const handleRemoveMember = async (memberId) => {
    if (!group?.isCreator) return;
    if (!window.confirm("Remove this member from the group?")) return;
    setBusy(true);
    try {
      await api(`/groups/${encodeURIComponent(code)}/members/${encodeURIComponent(memberId)}`, {
        method: "DELETE"
      });
      setGroup((curr) => curr ? {
        ...curr,
        members: curr.members.filter((m) => m.id !== memberId && m.displayName !== memberId)
      } : curr);
      setNotice("Member removed.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Action: Save Group Settings
  const saveSettings = async (e) => {
    e.preventDefault();
    if (!group?.isCreator || busy) return;
    setBusy(true);
    setError("");
    try {
      const data = await api(`/groups/${encodeURIComponent(code)}`, {
        method: "PATCH",
        body: { name: group.name, description: group.description }
      });
      setGroup(data.group);
      setNotice("Group settings saved.");
      setSettingsOpen(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Action: Generate New Invite
  const createInvitation = async () => {
    setBusy(true);
    try {
      const data = await api(`/groups/${encodeURIComponent(code)}/invitations`, { method: "POST", body: {} });
      setNotice("New invitation link created. Previous links were revoked.");
      copy(data.inviteUrl, "Invitation link");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Action: Revoke Invitations
  const revokeInvitations = async () => {
    if (!group?.isCreator) return;
    setBusy(true);
    try {
      await api(`/groups/${encodeURIComponent(code)}/invitations`, { method: "DELETE" });
      setNotice("All group invitations have been revoked.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Action: Delete Group
  const deleteGroup = async () => {
    if (!window.confirm("Permanently delete this group, its files, compiler runs, and chat for everyone?")) return;
    setBusy(true);
    try {
      await api(`/groups/${encodeURIComponent(code)}`, { method: "DELETE" });
      navigate("/");
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const copy = async (value, label) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(`${label} copied.`);
      setError("");
    } catch {
      setError("Could not copy. Select and copy manually.");
    }
  };

  // Standard group link
  const groupInviteUrl = `${window.location.origin}/gp${code.slice(4)}${invitation ? `?invite=${encodeURIComponent(invitation)}` : ""}`;

  if (loading) {
    return (
      <div className="center-screen">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Spinner /> <span>Loading collaborative IDE…</span>
        </div>
      </div>
    );
  }

  if (!group) {
    return (
      <div className="center-screen">
        <div className="auth-card" style={{ maxWidth: 440, textAlign: "center" }}>
          <div className="clipboard-mark" style={{ margin: "0 auto 12px" }}><Folder size={24} /></div>
          <h1>Group Unavailable</h1>
          <p className="muted">{error || "This group may have been deleted or expired."}</p>
          <Link to="/" className="btn primary" style={{ marginTop: 16 }}>Return Home</Link>
        </div>
      </div>
    );
  }

  // Invitation / Join Screen if not yet a member
  if (!group.isMember) {
    return (
      <div className="center-screen">
        <div className="auth-card" style={{ maxWidth: 460 }}>
          <Link to="/" className="clipboard-back" style={{ marginBottom: 10 }}><ArrowLeft size={16} /> Home</Link>
          <div className="clipboard-mark"><Users size={22} /></div>
          <p className="clipboard-eyebrow" style={{ marginTop: 8 }}>COLLABORATIVE WORKSPACE</p>
          <h1 style={{ marginTop: 2 }}>{group.name}</h1>
          <p className="muted">{group.description || "Shared collaborative editor and group workspace."}</p>

          {/* Show existing members list before joining */}
          {group.members && group.members.length > 0 && (
            <div style={{ marginTop: 14, marginBottom: 8, padding: "10px 12px", background: "var(--panel-2)", borderRadius: 8, border: "1px solid var(--line)" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase" }}>
                Current members ({group.members.length}):
              </span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                {group.members.map((m) => (
                  <span key={m.id || m.displayName} style={{ fontSize: 12, padding: "2px 8px", background: "var(--bg)", borderRadius: 4, border: "1px solid var(--line)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <i style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e", display: "inline-block" }} />
                    {m.displayName} {m.isCreator ? "(Creator)" : ""}
                  </span>
                ))}
              </div>
            </div>
          )}

          <form className="clipboard-create-form" onSubmit={join} style={{ marginTop: 14 }}>
            <label>
              Invitation code
              <input
                value={invitation}
                onChange={(e) => setInvitation(e.target.value.toUpperCase())}
                maxLength={32}
                required
                placeholder="Paste invitation code"
              />
            </label>
            <label>
              Your display name
              <input
                value={requestedName}
                onChange={(e) => setRequestedName(e.target.value)}
                maxLength={32}
                required
                placeholder="e.g. Alice"
              />
            </label>
            {error && <div className="alert">{error}</div>}
            <button className="btn primary wide" disabled={busy} style={{ marginTop: 8 }}>
              {busy ? <Spinner /> : "Join IDE Workspace"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const activeParticipants = participants.filter((p) => p.id !== provider?.socket?.id);

  return (
    <div className="ide-container">
      {/* ================= TOP TOOLBAR ================= */}
      <header className="ide-topbar">
        {/* Left: Brand, Back, and Group Code */}
        <div className="ide-topbar-left">
          <Link to="/" className="ide-btn-icon" title="Return Home"><ArrowLeft size={16} /></Link>
          <div className="ide-brand-group">
            <span className="ide-group-title" title={group.description || group.name}>
              <Folder size={15} className="ide-folder-icon" />
              <strong>{group.name}</strong>
            </span>
            <button
              className="ide-pill-code"
              onClick={() => copy(groupInviteUrl, "Group link")}
              title="Click to copy group link"
            >
              <span>gp</span>
              <code>{code.slice(4)}</code>
              <Copy size={11} />
            </button>
          </div>
        </div>

        {/* Center: Language selector & Run button */}
        <div className="ide-topbar-center">
          <div className="ide-lang-selector">
            <select
              value={activeFile?.language || DEFAULT_LANGUAGE}
              onChange={(e) => changeActiveLanguage(e.target.value)}
              title="Select code language"
            >
              {LANGUAGES.map(([key, label]) => (
                <option value={key} key={key}>{label}</option>
              ))}
            </select>
          </div>

          <button
            className={`btn small primary ide-run-btn ${executing ? "running" : ""}`}
            onClick={runCode}
            disabled={executing || !activeFile}
            title="Execute code (Ctrl+Enter / Cmd+Enter)"
          >
            {executing ? <Spinner /> : <Play size={14} fill="currentColor" />}
            <span>Run</span>
            <kbd>Ctrl+↵</kbd>
          </button>
        </div>

        {/* Right: Actions, Save status, Collaborators, Panel toggles */}
        <div className="ide-topbar-right">
          {/* Sync / Save status */}
          <span className="ide-save-status" title={lastSaved ? `Last saved at ${new Date(lastSaved).toLocaleTimeString()}` : "Syncing in real-time"}>
            <Clock size={12} />
            <span>{lastSaved ? new Date(lastSaved).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : "Live"}</span>
          </span>

          <button className="ide-btn-icon" onClick={handleSaveWorkspace} title="Save changes now">
            <Save size={15} />
          </button>

          {/* Active Collaborators */}
          <div className="ide-collaborators" title={`${participants.length} online collaborator(s)`}>
            {activeParticipants.slice(0, 4).map((p) => (
              <span
                key={p.id}
                className="ide-avatar"
                style={{ backgroundColor: p.color }}
                title={`${p.name} (online)`}
              >
                {p.name.charAt(0).toUpperCase()}
              </span>
            ))}
            <span className="ide-collaborators-count">
              <Users size={13} /> {participants.length}
            </span>
          </div>

          <div className="ide-divider-vertical" />

          {/* Panel toggles */}
          <button
            className={`ide-btn-icon ${filesPanelOpen ? "active" : ""}`}
            onClick={() => setFilesPanelOpen((v) => !v)}
            title="Toggle File Explorer"
          >
            {filesPanelOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>

          <button
            className={`ide-btn-icon ${membersPanelOpen ? "active" : ""}`}
            onClick={() => setMembersPanelOpen((v) => !v)}
            title="Toggle Member List & Controls"
          >
            <Users size={16} />
          </button>

          <button
            className={`ide-btn-icon ${terminalOpen ? "active" : ""}`}
            onClick={() => setTerminalOpen((v) => !v)}
            title="Toggle Terminal & Output"
          >
            <Terminal size={16} />
          </button>

          <button
            className={`ide-btn-icon ${chatOpen ? "active" : ""}`}
            onClick={() => setChatOpen((v) => !v)}
            title="Toggle Group Chat"
          >
            <MessageCircle size={16} />
          </button>

          {/* Settings modal trigger */}
          {group.isCreator && (
            <button className="ide-btn-icon" onClick={() => setSettingsOpen(true)} title="Group Settings">
              <Settings2 size={16} />
            </button>
          )}

          <ThemeToggle />
        </div>
      </header>

      {/* Global Alerts / Notices */}
      {error && (
        <div className="alert ide-alert">
          <span>{error}</span>
          <button onClick={() => setError("")}><X size={14} /></button>
        </div>
      )}
      {notice && (
        <div className="clipboard-notice ide-notice">
          <Check size={14} /> <span>{notice}</span>
          <button onClick={() => setNotice("")}><X size={14} /></button>
        </div>
      )}
      {executionBanner && (
        <div className="ide-exec-banner">
          <Spinner /> <span>{executionBanner}</span>
        </div>
      )}

      {/* ================= MAIN IDE BODY ================= */}
      <main className="ide-main-body">
        {/* ---- LEFT: File Explorer Panel ---- */}
        {filesPanelOpen && (
          <aside className="ide-files-panel">
            <div className="ide-files-header">
              <span>EXPLORER</span>
              <button
                className="ide-btn-icon small"
                onClick={() => setNewFileModal(true)}
                title="Create new file"
              >
                <FilePlus size={14} />
              </button>
            </div>

            <div className="ide-files-list">
              {files.map((file) => {
                const isActive = file.id === activeFile?.id;
                return (
                  <div
                    key={file.id}
                    className={`ide-file-row ${isActive ? "active" : ""}`}
                    onClick={() => setActiveFileId(file.id)}
                  >
                    <FileCode size={14} className="ide-file-icon" />
                    <span className="ide-file-name" title={file.name}>{file.name}</span>
                    <div className="ide-file-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="ide-btn-tiny"
                        onClick={() => {
                          setRenameModal(file);
                          setRenameValue(file.name);
                        }}
                        title="Rename file"
                      >
                        <Edit2 size={12} />
                      </button>
                      {files.length > 1 && (
                        <button
                          className="ide-btn-tiny danger"
                          onClick={() => handleDeleteFile(file)}
                          title="Delete file"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </aside>
        )}

        {/* ---- CENTER: Editor & Bottom Split ---- */}
        <section className="ide-center-panel">
          {/* File Tabs */}
          <div className="ide-tabs-bar">
            {files.map((file) => (
              <div
                key={file.id}
                className={`ide-tab ${file.id === activeFile?.id ? "active" : ""}`}
                onClick={() => setActiveFileId(file.id)}
              >
                <FileCode size={13} />
                <span>{file.name}</span>
                {files.length > 1 && (
                  <button
                    className="ide-tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteFile(file);
                    }}
                    title="Close file"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            ))}
            <button
              className="ide-tab-add"
              onClick={() => setNewFileModal(true)}
              title="Add file"
            >
              <FilePlus size={13} />
            </button>
          </div>

          {/* Monaco Editor Container */}
          <div className={`ide-monaco-wrapper ${terminalOpen && terminalMaximized ? "hidden" : ""}`}>
            {provider && activeFile ? (
              <Editor
                height="100%"
                language={activeFile.language || "plaintext"}
                theme={theme === "dark" ? "vs-dark" : "light"}
                options={{
                  automaticLayout: true,
                  minimap: { enabled: false },
                  fontSize: 14,
                  lineNumbers: "on",
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                  tabSize: 4,
                  padding: { top: 12, bottom: 12 },
                  folding: true,
                  renderWhitespace: "selection"
                }}
                onMount={onEditorMount}
              />
            ) : (
              <div className="ide-loading-placeholder">
                <Spinner /> <span>Connecting collaborative workspace…</span>
              </div>
            )}
          </div>

          {/* ---- BOTTOM: Terminal / Execution Panel ---- */}
          {terminalOpen && (
            <div className={`ide-terminal-panel ${terminalMaximized ? "maximized" : ""}`}>
              <div className="ide-terminal-header">
                <div className="ide-terminal-tabs">
                  <button
                    className={`ide-terminal-tab ${terminalTab === "output" ? "active" : ""}`}
                    onClick={() => setTerminalTab("output")}
                  >
                    <Terminal size={13} />
                    <span>Output</span>
                    {currentResult && (
                      <span className={`ide-status-chip ${currentResult.status === "Accepted" ? "success" : "error"}`}>
                        {currentResult.status}
                      </span>
                    )}
                  </button>
                  <button
                    className={`ide-terminal-tab ${terminalTab === "stdin" ? "active" : ""}`}
                    onClick={() => setTerminalTab("stdin")}
                  >
                    <FileText size={13} />
                    <span>Custom Input (stdin)</span>
                  </button>
                  <button
                    className={`ide-terminal-tab ${terminalTab === "history" ? "active" : ""}`}
                    onClick={() => setTerminalTab("history")}
                  >
                    <History size={13} />
                    <span>History ({executionHistory.length})</span>
                  </button>
                </div>

                <div className="ide-terminal-controls">
                  <button
                    className="ide-btn-tiny"
                    onClick={() => setTerminalMaximized((m) => !m)}
                    title={terminalMaximized ? "Restore panel size" : "Maximize panel"}
                  >
                    {terminalMaximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                  </button>
                  <button
                    className="ide-btn-tiny"
                    onClick={() => setTerminalOpen(false)}
                    title="Close terminal"
                  >
                    <X size={13} />
                  </button>
                </div>
              </div>

              {/* Terminal Tab Content */}
              <div className="ide-terminal-body">
                {terminalTab === "output" && (
                  <div className="ide-output-view">
                    {currentResult ? (
                      <div className="ide-result-container">
                        {/* Summary Bar */}
                        <div className="ide-result-meta">
                          <span className={`ide-badge-status ${currentResult.status === "Accepted" ? "success" : "error"}`}>
                            {currentResult.status}
                          </span>
                          <span className="ide-meta-item">
                            Language: <strong>{currentResult.languageName || currentResult.language}</strong>
                          </span>
                          <span className="ide-meta-item">
                            Time: <strong>{currentResult.time}s</strong>
                          </span>
                          <span className="ide-meta-item">
                            Memory: <strong>{currentResult.memory} KB</strong>
                          </span>
                          <span className="ide-meta-item">
                            Ran by: <strong>@{currentResult.executedBy}</strong>
                          </span>
                          {currentResult.engine && (
                            <span className="ide-meta-engine">
                              Engine: {currentResult.engine}
                            </span>
                          )}
                        </div>

                        {/* Compilation output if any */}
                        {currentResult.compileOutput && (
                          <div className="ide-section-compile">
                            <div className="ide-section-title error">Compilation Output</div>
                            <pre className="ide-terminal-text error">{currentResult.compileOutput}</pre>
                          </div>
                        )}

                        {/* Stderr if any */}
                        {currentResult.stderr && (
                          <div className="ide-section-stderr">
                            <div className="ide-section-title error">Standard Error</div>
                            <pre className="ide-terminal-text error">{currentResult.stderr}</pre>
                          </div>
                        )}

                        {/* Stdout */}
                        <div className="ide-section-stdout">
                          <div className="ide-section-title">Standard Output</div>
                          <pre className="ide-terminal-text">
                            {currentResult.stdout || "(Program finished with no output)"}
                          </pre>
                        </div>
                      </div>
                    ) : (
                      <div className="ide-terminal-empty">
                        <Terminal size={22} className="muted" />
                        <p>No executions yet. Click <strong>Run</strong> or press <strong>Ctrl+Enter</strong> to execute code.</p>
                      </div>
                    )}
                  </div>
                )}

                {terminalTab === "stdin" && (
                  <div className="ide-stdin-view">
                    <p className="ide-stdin-hint">Input entered here will be passed to your program via standard input (stdin):</p>
                    <textarea
                      value={stdin}
                      onChange={(e) => setStdin(e.target.value)}
                      placeholder="Enter custom input here..."
                      className="ide-stdin-textarea"
                    />
                  </div>
                )}

                {terminalTab === "history" && (
                  <div className="ide-history-view">
                    {executionHistory.length === 0 ? (
                      <p className="muted" style={{ padding: 16 }}>No execution history yet.</p>
                    ) : (
                      <div className="ide-history-list">
                        {executionHistory.map((item, idx) => (
                          <div
                            key={item.id || idx}
                            className={`ide-history-item ${currentResult?.id === item.id ? "selected" : ""}`}
                            onClick={() => {
                              setCurrentResult(item);
                              setTerminalTab("output");
                            }}
                          >
                            <span className={`ide-badge-status small ${item.status === "Accepted" ? "success" : "error"}`}>
                              {item.status}
                            </span>
                            <span className="ide-history-file">{item.fileName || "code"} ({item.language})</span>
                            <span className="ide-history-time">{item.time}s</span>
                            <span className="ide-history-user">@{item.executedBy}</span>
                            <span className="ide-history-date">
                              {new Date(item.createdAt).toLocaleTimeString()}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        {/* ---- RIGHT: Members List Panel ---- */}
        {membersPanelOpen && (
          <aside className="ide-members-panel">
            <div className="ide-members-header">
              <span className="ide-members-title">
                <Users size={15} />
                <span>Members ({group.members?.length || 0})</span>
              </span>
              <button className="ide-btn-tiny" onClick={() => setMembersPanelOpen(false)} title="Close members panel">
                <X size={14} />
              </button>
            </div>

            <div className="ide-members-invite-box">
              <label>Invitation Link</label>
              <div className="ide-invite-row">
                <input value={groupInviteUrl} readOnly onFocus={(e) => e.target.select()} />
                <button className="btn small ghost" onClick={() => copy(groupInviteUrl, "Group link")} title="Copy invitation link">
                  <Copy size={13} />
                </button>
              </div>
              {group.isCreator && (
                <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                  <button className="btn small ghost" onClick={createInvitation} disabled={busy} title="Generate fresh invitation link">
                    New Invite
                  </button>
                  <button className="btn small ghost danger" onClick={revokeInvitations} disabled={busy} title="Revoke all active links">
                    Revoke All
                  </button>
                </div>
              )}
            </div>

            <div className="ide-members-list">
              {(group.members || []).map((m) => {
                const isOnline = participants.some((p) => p.name === m.displayName || p.id === m.id);
                return (
                  <div className="ide-member-item" key={m.id || m.displayName}>
                    <span className={`ide-online-dot ${isOnline ? "online" : "offline"}`} title={isOnline ? "Online" : "Offline"} />
                    <div className="ide-member-info">
                      <strong className="ide-member-name">{m.displayName}</strong>
                      <span className="ide-member-joined">Joined {new Date(m.joinedAt).toLocaleDateString()}</span>
                    </div>
                    {m.isCreator && <span className="ide-badge creator">Creator</span>}
                    {group.isCreator && !m.isCreator && (
                      <button
                        className="ide-btn-tiny danger"
                        onClick={() => handleRemoveMember(m.id || m.displayName)}
                        title="Remove member"
                      >
                        <UserMinus size={13} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </aside>
        )}

        {/* ---- RIGHT: Group Chat Panel ---- */}
        {chatOpen && provider && (
          <aside className="ide-chat-panel">
            <div className="ide-chat-header">
              <span className="ide-chat-title">
                <MessageCircle size={15} />
                <span>Group Chat</span>
              </span>
              <button
                className="ide-btn-tiny"
                onClick={() => setChatOpen(false)}
                title="Collapse chat"
              >
                <X size={14} />
              </button>
            </div>
            <div className="ide-chat-content">
              <RoomChat kind="group" code={code} displayName={displayName} socket={provider.socket} />
            </div>
          </aside>
        )}
      </main>

      {/* ================= MODALS ================= */}

      {/* Modal: New File */}
      {newFileModal && (
        <div className="ide-modal-backdrop" onClick={() => setNewFileModal(false)}>
          <div className="ide-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="ide-modal-header">
              <h2>Create New File</h2>
              <button className="ide-btn-tiny" onClick={() => setNewFileModal(false)}><X size={15} /></button>
            </div>
            <form onSubmit={handleCreateFile}>
              <label>
                File name with extension (e.g. <code>solution.py</code>, <code>Main.java</code>)
                <input
                  value={newFileName}
                  onChange={(e) => setNewFileName(e.target.value)}
                  placeholder="e.g. script.py"
                  autoFocus
                  required
                />
              </label>
              <div className="ide-modal-actions">
                <button type="button" className="btn ghost" onClick={() => setNewFileModal(false)}>Cancel</button>
                <button type="submit" className="btn primary" disabled={busy}>
                  {busy ? <Spinner /> : "Create File"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Rename File */}
      {renameModal && (
        <div className="ide-modal-backdrop" onClick={() => setRenameModal(null)}>
          <div className="ide-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="ide-modal-header">
              <h2>Rename File</h2>
              <button className="ide-btn-tiny" onClick={() => setRenameModal(null)}><X size={15} /></button>
            </div>
            <form onSubmit={handleRenameFile}>
              <label>
                New file name
                <input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  autoFocus
                  required
                />
              </label>
              <div className="ide-modal-actions">
                <button type="button" className="btn ghost" onClick={() => setRenameModal(null)}>Cancel</button>
                <button type="submit" className="btn primary" disabled={busy}>
                  {busy ? <Spinner /> : "Rename"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Group Settings (Creator only) */}
      {settingsOpen && group.isCreator && (
        <div className="ide-modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="ide-modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <div className="ide-modal-header">
              <h2>Workspace Settings</h2>
              <button className="ide-btn-tiny" onClick={() => setSettingsOpen(false)}><X size={15} /></button>
            </div>

            {/* Share Link Row */}
            <div className="ide-settings-link-box">
              <label>Workspace Link</label>
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <input value={groupInviteUrl} readOnly onFocus={(e) => e.target.select()} style={{ flex: 1 }} />
                <button type="button" className="btn ghost small" onClick={() => copy(groupInviteUrl, "Group link")}>
                  <Copy size={13} /> Copy
                </button>
                <button type="button" className="btn ghost small" onClick={createInvitation} disabled={busy}>
                  <ExternalLink size={13} /> New Link
                </button>
              </div>
            </div>

            <form onSubmit={saveSettings} style={{ marginTop: 14 }}>
              <label>
                Group Name
                <input
                  value={group.name}
                  maxLength={64}
                  onChange={(e) => setGroup((curr) => ({ ...curr, name: e.target.value }))}
                />
              </label>
              <label style={{ marginTop: 10 }}>
                Description
                <input
                  value={group.description}
                  maxLength={500}
                  onChange={(e) => setGroup((curr) => ({ ...curr, description: e.target.value }))}
                />
              </label>
              <div className="ide-modal-actions" style={{ marginTop: 18 }}>
                <button type="button" className="btn danger small" onClick={deleteGroup} disabled={busy}>
                  <Trash2 size={13} /> Delete Group
                </button>
                <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                  <button type="button" className="btn ghost small" onClick={() => setSettingsOpen(false)}>Cancel</button>
                  <button type="submit" className="btn primary small" disabled={busy}>
                    <Settings2 size={13} /> Save Settings
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
