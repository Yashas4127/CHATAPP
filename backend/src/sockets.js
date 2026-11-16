import cookie from "cookie";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { COOKIE_NAME, userFromToken } from "./auth.js";
import { groupMemberForToken, GROUP_SESSION_COOKIE, matchesGuestToken } from "./guest-sessions.js";
import { Clipboard, Conversation, Group, Invitation, RoomMessage, WorkspaceFile } from "./models.js";
import { normalizeClipCode } from "./clipboard-routes.js";
import { normalizeGroupCode } from "./group-routes.js";

const isId = (value) => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
const isClipboardCode = (value) => typeof value === "string" && /^CLP-(?:[A-Z0-9]|[A-Z0-9][A-Z0-9-]{0,22}[A-Z0-9])$/i.test(value);
const MAX_COLLAB_UPDATE_BYTES = 512 * 1024;
const SOCKET_ORIGIN = Symbol("socket");
const ownerCookieName = (code) => `wc_clip_owner_${code}`;
const toBase64 = (bytes) => Buffer.from(bytes).toString("base64");
const documentModel = (kind) => kind === "clipboard" ? Clipboard : Group;
const documentKey = (kind, code) => `${kind}:${code}`;

function fromBase64(value) {
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return value;
  }
  if (typeof value !== "string" || value.length > MAX_COLLAB_UPDATE_BYTES * 2) {
    throw new Error("Invalid collaboration update.");
  }
  return Buffer.from(value, "base64");
}

function toUint8Array(val) {
  if (!val) return new Uint8Array(0);
  if (val.buffer && Buffer.isBuffer(val.buffer)) return new Uint8Array(val.buffer);
  if (Buffer.isBuffer(val)) return new Uint8Array(val);
  if (val instanceof Uint8Array) return val;
  if (val.buffer instanceof ArrayBuffer) return new Uint8Array(val.buffer);
  if (typeof val.read === "function" && typeof val.length === "function") {
    return new Uint8Array(val.read(0, val.length()));
  }
  return new Uint8Array(Buffer.from(val));
}

function activeClipboardFilter(code) {
  return {
    code,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }]
  };
}

function unavailableDocument(kind) {
  const error = new Error(`${kind === "clipboard" ? "Clipboard" : "Group"} not found or expired.`);
  error.code = "COLLAB_DOCUMENT_GONE";
  return error;
}

export function setupSockets(io) {
  const connections = new Map();
  const roomParticipants = new Map();
  const documents = new Map();
  const documentLoads = new Map();

  function closeDocument(kind, code, entry) {
    if (entry.closed) return;
    entry.closed = true;
    clearTimeout(entry.persistTimer);
    clearTimeout(entry.idleTimer);
    entry.pendingUpdates.length = 0;
    entry.awareness.destroy();
    entry.doc.destroy();
    documents.delete(documentKey(kind, code));
  }

  function scheduleIdleCleanup(kind, code, entry) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (!roomParticipants.get(documentKey(kind, code))?.size) closeDocument(kind, code, entry);
    }, 60_000);
  }

  async function getDocument(kind, code) {
    const key = documentKey(kind, code);
    if (documents.has(key)) {
      const entry = documents.get(key);
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
      return entry;
    }
    if (documentLoads.has(key)) return documentLoads.get(key);

    const load = (async () => {
      const filter = kind === "clipboard" ? activeClipboardFilter(code) : { code };
      const record = await documentModel(kind).findOne(filter)
        .select("documentState documentUpdates content language")
        .lean();
      if (!record) throw unavailableDocument(kind);
      const doc = new Y.Doc();
      const state = toUint8Array(record.documentState);
      if (state.length) {
        try {
          Y.applyUpdate(doc, state);
        } catch (e) {
          console.warn("Could not apply initial documentState:", e.message);
        }
      }
      for (const update of record.documentUpdates || []) {
        const u = toUint8Array(update);
        if (u.length) {
          try {
            Y.applyUpdate(doc, u);
          } catch (e) {
            console.warn("Could not apply documentUpdate:", e.message);
          }
        }
      }

      if (!doc.getText("content").length && record.content) {
        doc.getText("content").insert(0, record.content);
      }
      if (!doc.getMap("meta").get("language")) {
        doc.getMap("meta").set("language", record.language || "plaintext");
      }
      if (kind === "group") {
        const files = await WorkspaceFile.find({ groupCode: code }).sort({ isDefault: -1, createdAt: 1 }).lean();
        if (files && files.length > 0) {
          for (const f of files) {
            const fText = doc.getText(`file:${f.fileId}`);
            if (!fText.length && f.content) {
              fText.insert(0, f.content);
            }
          }
        }
      }
      const entry = {
        doc,
        awareness: new Awareness(doc),
        queue: Promise.resolve(),
        pendingUpdates: [],
        updateCount: record.documentUpdates?.length || 0,
        persistTimer: null,
        idleTimer: null,
        closed: false
      };
      documents.set(key, entry);
      return entry;
    })();
    documentLoads.set(key, load);
    try {
      return await load;
    } finally {
      if (documentLoads.get(key) === load) documentLoads.delete(key);
    }
  }

  function persistDocument(kind, code, entry) {
    if (entry.closed) return Promise.resolve(false);
    clearTimeout(entry.persistTimer);
    const operation = entry.queue.then(async () => {
      const filter = kind === "clipboard" ? activeClipboardFilter(code) : { code };
      const model = documentModel(kind);
      if (!entry.pendingUpdates.length) {
        const saved = await model.findOne(filter).select("updatedAt").lean();
        if (!saved) throw unavailableDocument(kind);
        io.to(documentKey(kind, code)).emit("collab:saved", { updatedAt: saved.updatedAt.toISOString() });
        return true;
      }

      const updates = entry.pendingUpdates.slice();
      const compact = entry.updateCount + updates.length >= 100;
      const update = {
        $set: {
          content: entry.doc.getText("content").toString(),
          language: entry.doc.getMap("meta").get("language") || "plaintext"
        }
      };
      if (compact) {
        update.$set.documentState = Buffer.from(Y.encodeStateAsUpdate(entry.doc));
        update.$set.documentUpdates = [];
      } else {
        update.$push = { documentUpdates: { $each: updates } };
      }
      const result = await model.updateOne(filter, update);
      if (result.matchedCount !== 1) throw unavailableDocument(kind);
      if (kind === "group") {
        try {
          const files = await WorkspaceFile.find({ groupCode: code }).select("fileId isDefault").lean();
          for (const f of files) {
            const fText = entry.doc.getText(`file:${f.fileId}`);
            if (fText && fText.length > 0) {
              await WorkspaceFile.updateOne({ groupCode: code, fileId: f.fileId }, { $set: { content: fText.toString() } });
            } else if (f.isDefault && entry.doc.getText("content").length > 0) {
              await WorkspaceFile.updateOne({ groupCode: code, fileId: f.fileId }, { $set: { content: entry.doc.getText("content").toString() } });
            }
          }
        } catch (filePersistErr) {
          console.error("Workspace file sync error:", filePersistErr.message);
        }
      }

      entry.pendingUpdates.splice(0, updates.length);
      entry.updateCount = compact ? 0 : entry.updateCount + updates.length;
      const saved = await model.findOne(filter).select("updatedAt").lean();
      if (!saved) throw unavailableDocument(kind);
      io.to(documentKey(kind, code)).emit("collab:saved", { updatedAt: saved.updatedAt.toISOString() });
      return true;
    });
    entry.queue = operation.catch((error) => {
      if (error.code === "COLLAB_DOCUMENT_GONE") {
        io.to(documentKey(kind, code)).emit(kind === "clipboard" ? "clipboard:deleted" : "group:deleted");
        io.in(documentKey(kind, code)).disconnectSockets(true);
        closeDocument(kind, code, entry);
        return false;
      }
      console.error("collaboration persistence failed:", error.message);
      io.to(documentKey(kind, code)).emit("collab:error", { message: "Could not persist the latest document changes." });
      return false;
    });
    return entry.queue;
  }

  function schedulePersist(kind, code, entry) {
    if (entry.closed) return;
    clearTimeout(entry.persistTimer);
    entry.persistTimer = setTimeout(() => persistDocument(kind, code, entry), 250);
  }

  // Middleware: parse cookies, authenticate if credentials present, allow guest connections
  io.use(async (socket, next) => {
    try {
      const cookies = cookie.parse(socket.handshake.headers.cookie || "");
      const user = await userFromToken(cookies[COOKIE_NAME]);
      if (user) socket.data.user = { id: user.id, username: user.username, role: user.role };

      const clipboardValue = socket.handshake.auth?.clipboardCode;
      const groupValue = socket.handshake.auth?.groupCode;
      const clipboardCode = typeof clipboardValue === "string" ? normalizeClipCode(clipboardValue) : "";
      const groupCode = typeof groupValue === "string" ? normalizeGroupCode(groupValue) : "";

      if (isClipboardCode(clipboardCode)) {
        const clipboard = await Clipboard.findOne(activeClipboardFilter(clipboardCode)).select("+creatorTokenHash permission").lean();
        if (clipboard) {
          const ownerToken = cookies[ownerCookieName(clipboardCode)];
          socket.data.collab = {
            kind: "clipboard",
            code: clipboardCode,
            room: documentKey("clipboard", clipboardCode),
            isCreator: matchesGuestToken(ownerToken, clipboard.creatorTokenHash),
            canEdit: clipboard.permission === "editable" || matchesGuestToken(ownerToken, clipboard.creatorTokenHash),
            displayName: typeof socket.handshake.auth?.displayName === "string"
              ? socket.handshake.auth.displayName.trim().slice(0, 32) || "Guest"
              : user?.username || "Guest",
            color: /^#[0-9A-F]{6}$/i.test(socket.handshake.auth?.color || "")
              ? socket.handshake.auth.color
              : "#8B5CF6",
            clientId: Number.isSafeInteger(socket.handshake.auth?.clientId)
              ? socket.handshake.auth.clientId
              : null
          };
        }
      } else if (groupCode && /^GRP-[A-F0-9]{24}$/.test(groupCode)) {
        const group = await Group.findOne({ code: groupCode }).select("+creatorTokenHash").lean();
        if (group) {
          const token = cookies[GROUP_SESSION_COOKIE(groupCode)];
          const member = groupMemberForToken(group, token);
          if (member) {
            socket.data.collab = {
              kind: "group",
              code: groupCode,
              room: documentKey("group", groupCode),
              isCreator: matchesGuestToken(token, group.creatorTokenHash),
              canEdit: true,
              memberTokenHash: member.tokenHash,
              displayName: member.displayName,
              color: /^#[0-9A-F]{6}$/i.test(socket.handshake.auth?.color || "")
                ? socket.handshake.auth.color
                : "#8B5CF6",
              clientId: Number.isSafeInteger(socket.handshake.auth?.clientId)
                ? socket.handshake.auth.clientId
                : null
            };
          }
        }
      }
      next();
    } catch (error) {
      next(error);
    }
  });

  io.on("connection", (socket) => {
    const me = socket.data.user;
    if (me) {
      socket.join(`user:${me.id}`);
      if (me.role === "admin") socket.join("admin:overview");
      const count = (connections.get(me.id) || 0) + 1;
      connections.set(me.id, count);
      if (count === 1) io.emit("presence", { userId: me.id, online: true });
    }

    // Initialize collaboration if setup during handshake
    const initCollabSession = (collab) => {
      socket.data.collab = collab;
      socket.join(collab.room);
      const participants = roomParticipants.get(collab.room) || new Map();
      participants.set(socket.id, {
        id: socket.id,
        socketId: socket.id,
        name: collab.displayName,
        color: collab.color,
        clientId: collab.clientId,
        isCreator: collab.isCreator,
        online: true
      });
      roomParticipants.set(collab.room, participants);

      const participantList = [...participants.values()];
      // Emit presence matching both standard and collab naming
      io.to(collab.room).emit("collab:participants", participantList);
      if (collab.kind === "clipboard") {
        io.to(collab.room).emit("clipboard:presence", participantList);
      } else {
        io.to(collab.room).emit("group:presence", participantList);
      }

      socket.data.collabReady = getDocument(collab.kind, collab.code).then((entry) => {
        if (!socket.connected) return entry;
        const clientIds = [...entry.awareness.getStates().keys()].filter((id) => id !== entry.doc.clientID);
        if (clientIds.length) {
          const update = toBase64(encodeAwarenessUpdate(entry.awareness, clientIds));
          socket.emit("collab:awareness", { update });
          socket.emit("document:awareness", { update });
        }
        return entry;
      }).catch((error) => {
        socket.emit("collab:error", { message: error.message });
        throw error;
      });
      socket.data.collabReady.catch(() => {});
    };

    if (socket.data.collab) {
      initCollabSession(socket.data.collab);
    }

    // ================= CLIPBOARD SOCKET EVENTS =================
    // clipboard:join { code, displayName, color, clientId }
    socket.on("clipboard:join", async (payload = {}) => {
      try {
        const rawCode = payload.code || socket.handshake.auth?.clipboardCode;
        const code = normalizeClipCode(rawCode);
        if (!isClipboardCode(code)) {
          return socket.emit("collab:error", { message: "Invalid clipboard code." });
        }
        const clipboard = await Clipboard.findOne(activeClipboardFilter(code)).select("+creatorTokenHash permission").lean();
        if (!clipboard) {
          return socket.emit("collab:error", { message: "Clipboard not found or expired." });
        }

        const cookies = cookie.parse(socket.handshake.headers.cookie || "");
        const ownerToken = cookies[ownerCookieName(code)] || payload.token;
        const isCreator = matchesGuestToken(ownerToken, clipboard.creatorTokenHash);

        const displayName = typeof payload.displayName === "string" && payload.displayName.trim()
          ? payload.displayName.trim().slice(0, 32)
          : socket.data.user?.username || "Guest";

        const color = /^#[0-9A-F]{6}$/i.test(payload.color || "")
          ? payload.color
          : "#8B5CF6";

        const clientId = Number.isSafeInteger(payload.clientId) ? payload.clientId : null;

        initCollabSession({
          kind: "clipboard",
          code,
          room: documentKey("clipboard", code),
          isCreator,
          canEdit: clipboard.permission === "editable" || isCreator,
          displayName,
          color,
          clientId
        });

        socket.emit("clipboard:joined", { code, isCreator, permission: clipboard.permission });
      } catch (err) {
        socket.emit("collab:error", { message: err.message });
      }
    });

    // clipboard:leave
    socket.on("clipboard:leave", () => {
      const collab = socket.data.collab;
      if (collab && collab.kind === "clipboard") {
        socket.leave(collab.room);
        const participants = roomParticipants.get(collab.room);
        participants?.delete(socket.id);
        const list = participants ? [...participants.values()] : [];
        io.to(collab.room).emit("clipboard:presence", list);
        io.to(collab.room).emit("collab:participants", list);
      }
    });

    // clipboard:update
    socket.on("clipboard:update", async (payload = {}) => {
      const collab = socket.data.collab;
      if (!collab || collab.kind !== "clipboard") return;
      io.to(collab.room).emit("clipboard:update", payload);
    });

    // ================= GROUP SOCKET EVENTS =================
    // group:join { code, displayName, color, clientId, token }
    socket.on("group:join", async (payload = {}) => {
      try {
        const rawCode = payload.code || socket.handshake.auth?.groupCode;
        const code = normalizeGroupCode(rawCode);
        if (!/^GRP-[A-F0-9]{24}$/.test(code)) {
          return socket.emit("collab:error", { message: "Invalid group code." });
        }
        const group = await Group.findOne({ code }).select("+creatorTokenHash").lean();
        if (!group) {
          return socket.emit("collab:error", { message: "Group not found." });
        }

        const cookies = cookie.parse(socket.handshake.headers.cookie || "");
        const token = cookies[GROUP_SESSION_COOKIE(code)] || payload.token;
        const member = groupMemberForToken(group, token);
        const isCreator = matchesGuestToken(token, group.creatorTokenHash);

        const displayName = member?.displayName || (typeof payload.displayName === "string" && payload.displayName.trim()
          ? payload.displayName.trim().slice(0, 32)
          : socket.data.user?.username || "Guest");

        const color = /^#[0-9A-F]{6}$/i.test(payload.color || "")
          ? payload.color
          : "#8B5CF6";

        const clientId = Number.isSafeInteger(payload.clientId) ? payload.clientId : null;

        initCollabSession({
          kind: "group",
          code,
          room: documentKey("group", code),
          isCreator,
          canEdit: true,
          memberTokenHash: member?.tokenHash || "",
          displayName,
          color,
          clientId
        });

        // Broadcast group:member-joined
        io.to(documentKey("group", code)).emit("group:member-joined", {
          displayName,
          socketId: socket.id,
          memberCount: group.members?.length || 1
        });

        socket.emit("group:joined", { code, isCreator });
      } catch (err) {
        socket.emit("collab:error", { message: err.message });
      }
    });

    // group:leave
    socket.on("group:leave", () => {
      const collab = socket.data.collab;
      if (collab && collab.kind === "group") {
        socket.leave(collab.room);
        const participants = roomParticipants.get(collab.room);
        participants?.delete(socket.id);
        const list = participants ? [...participants.values()] : [];
        io.to(collab.room).emit("group:member-left", { displayName: collab.displayName, socketId: socket.id });
        io.to(collab.room).emit("group:presence", list);
        io.to(collab.room).emit("collab:participants", list);
      }
    });

    // ================= COLLABORATION SYNC & UPDATE =================
    // document:sync or collab:sync-request
    const handleDocumentSync = async (payload = {}) => {
      const collab = socket.data.collab;
      if (!collab || !socket.data.collabReady) return;
      try {
        const entry = await socket.data.collabReady;
        const stateVector = payload.stateVector ? fromBase64(payload.stateVector) : new Uint8Array();
        const syncPayload = {
          update: toBase64(Y.encodeStateAsUpdate(entry.doc, stateVector)),
          serverStateVector: toBase64(Y.encodeStateVector(entry.doc)),
          language: entry.doc.getMap("meta").get("language") || "plaintext"
        };
        socket.emit("document:sync", syncPayload);
        socket.emit("collab:sync", syncPayload);
      } catch (error) {
        socket.emit("collab:error", { message: "Could not synchronize this document." });
        console.error("collaboration sync failed:", error.message);
      }
    };

    socket.on("document:sync", handleDocumentSync);
    socket.on("collab:sync-request", handleDocumentSync);

    // document:update or collab:update
    const handleDocumentUpdate = async (payload = {}) => {
      const collab = socket.data.collab;
      if (!collab || !socket.data.collabReady) return;
      try {
        const update = fromBase64(payload.update);
        const entry = await socket.data.collabReady;

        if (collab.kind === "clipboard" && !collab.canEdit && !collab.isCreator) {
          const current = await Clipboard.findOne(activeClipboardFilter(collab.code)).select("permission").lean();
          if (current?.permission !== "editable") {
            throw new Error("This clipboard is read-only.");
          }
        }

        const operation = entry.queue.then(async () => {
          Y.applyUpdate(entry.doc, update, SOCKET_ORIGIN);
          const updatePayload = { update: toBase64(update) };
          socket.to(collab.room).emit("document:update", updatePayload);
          socket.to(collab.room).emit("collab:update", updatePayload);
          entry.pendingUpdates.push(Buffer.from(update));
          schedulePersist(collab.kind, collab.code, entry);
        });
        entry.queue = operation.catch((error) => {
          console.error("collaboration update failed:", error.message);
          socket.emit("collab:error", { message: error.message || "Could not save this update." });
        });
        await entry.queue;
      } catch (error) {
        socket.emit("collab:error", { message: error.message || "Could not apply this update." });
      }
    };

    socket.on("document:update", handleDocumentUpdate);
    socket.on("collab:update", handleDocumentUpdate);

    // document:awareness or collab:awareness
    const handleDocumentAwareness = async (payload = {}) => {
      const collab = socket.data.collab;
      if (!collab || !socket.data.collabReady) return;
      try {
        const update = fromBase64(payload.update);
        const entry = await socket.data.collabReady;
        applyAwarenessUpdate(entry.awareness, update, socket);
        const awarenessPayload = { update: toBase64(update) };
        socket.to(collab.room).emit("document:awareness", awarenessPayload);
        socket.to(collab.room).emit("collab:awareness", awarenessPayload);
      } catch (error) {
        socket.emit("collab:error", { message: "Could not share collaborator presence." });
      }
    };

    socket.on("document:awareness", handleDocumentAwareness);
    socket.on("collab:awareness", handleDocumentAwareness);

    // Save now
    socket.on("collab:save", async () => {
      const collab = socket.data.collab;
      if (!collab || !socket.data.collabReady) return;
      try {
        const entry = await socket.data.collabReady;
        await persistDocument(collab.kind, collab.code, entry);
      } catch (error) {
        socket.emit("collab:error", { message: error.message || "Could not save this document." });
      }
    });

    // ================= CHAT SOCKET EVENTS =================
    // message:send
    socket.on("message:send", async (payload = {}) => {
      const collab = socket.data.collab;
      const roomType = payload.roomType || collab?.kind;
      const roomCode = payload.roomCode || collab?.code;
      const senderName = payload.senderName || collab?.displayName || socket.data.user?.username || "Guest";
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!roomType || !roomCode || (!text && !payload.attachment)) return;

      try {
        const roomName = documentKey(roomType, roomCode);
        const savedMessage = await RoomMessage.create({
          roomType,
          roomCode,
          senderName: senderName.slice(0, 32),
          senderSession: socket.id,
          text,
          attachment: payload.attachment || undefined
        });

        const shaped = {
          id: savedMessage._id.toString(),
          senderName: savedMessage.senderName,
          text: savedMessage.text,
          attachment: savedMessage.attachment?.data ? {
            name: savedMessage.attachment.name,
            mimeType: savedMessage.attachment.mimeType,
            size: savedMessage.attachment.size,
            url: `/rooms/${roomType}/${encodeURIComponent(roomCode)}/messages/${savedMessage._id}/attachment`
          } : null,
          reactions: [],
          createdAt: savedMessage.createdAt.toISOString()
        };

        io.to(roomName).emit("message:receive", shaped);
        io.to(roomName).emit("room:message", shaped);
      } catch (err) {
        socket.emit("chat:error", { message: err.message });
      }
    });

    // typing:start and typing:stop
    socket.on("typing:start", (payload = {}) => {
      const collab = socket.data.collab;
      const room = collab?.room || (payload.roomType && payload.roomCode ? documentKey(payload.roomType, payload.roomCode) : null);
      if (!room) return;
      const username = payload.username || collab?.displayName || "Guest";
      socket.to(room).emit("typing:start", { socketId: socket.id, username, isTyping: true });
      socket.to(room).emit("room:typing", { socketId: socket.id, name: username, isTyping: true });
    });

    socket.on("typing:stop", (payload = {}) => {
      const collab = socket.data.collab;
      const room = collab?.room || (payload.roomType && payload.roomCode ? documentKey(payload.roomType, payload.roomCode) : null);
      if (!room) return;
      const username = payload.username || collab?.displayName || "Guest";
      socket.to(room).emit("typing:stop", { socketId: socket.id, username, isTyping: false });
      socket.to(room).emit("room:typing", { socketId: socket.id, name: username, isTyping: false });
    });

    // Legacy room:typing
    socket.on("room:typing", async (payload = {}) => {
      const collab = socket.data.collab;
      if (!collab || typeof payload.isTyping !== "boolean") return;
      socket.to(collab.room).emit("room:typing", {
        socketId: socket.id,
        name: collab.displayName,
        isTyping: payload.isTyping
      });
      if (payload.isTyping) {
        socket.to(collab.room).emit("typing:start", { socketId: socket.id, username: collab.displayName, isTyping: true });
      } else {
        socket.to(collab.room).emit("typing:stop", { socketId: socket.id, username: collab.displayName, isTyping: false });
      }
    });

    // Admin subscriptions & 1-1 chat typing
    socket.on("admin:watch-conversation", async ({ conversationId } = {}) => {
      if (me?.role !== "admin" || !isId(conversationId)) return;
      try {
        const exists = await Conversation.exists({ _id: conversationId, "lastMessage.at": { $exists: true } });
        if (exists && socket.connected) socket.join(`admin:conversation:${conversationId}`);
      } catch (error) {
        console.error("admin conversation subscription failed:", error.message);
      }
    });

    socket.on("admin:unwatch-conversation", ({ conversationId } = {}) => {
      if (me?.role === "admin" && isId(conversationId)) socket.leave(`admin:conversation:${conversationId}`);
    });

    socket.on("typing", async (payload) => {
      try {
        const { conversationId, isTyping } = payload || {};
        if (!me || !isId(conversationId)) return;
        const conversation = await Conversation.findById(conversationId).select("members").lean();
        if (!conversation || !conversation.members.some((m) => m.toString() === me.id)) return;
        for (const member of conversation.members) {
          if (member.toString() !== me.id) {
            io.to(`user:${member}`).emit("typing", {
              conversationId, userId: me.id, username: me.username, isTyping: Boolean(isTyping)
            });
          }
        }
      } catch (error) {
        console.error("typing event failed:", error.message);
      }
    });

    // Disconnect cleanup
    socket.on("disconnect", async () => {
      if (me) {
        const left = (connections.get(me.id) || 1) - 1;
        if (left <= 0) {
          connections.delete(me.id);
          io.emit("presence", { userId: me.id, online: false });
        } else {
          connections.set(me.id, left);
        }
      }

      const collab = socket.data.collab;
      if (collab) {
        const participants = roomParticipants.get(collab.room);
        participants?.delete(socket.id);
        const count = participants?.size || 0;
        const list = participants ? [...participants.values()] : [];

        if (count) {
          io.to(collab.room).emit("collab:participants", list);
          if (collab.kind === "clipboard") {
            io.to(collab.room).emit("clipboard:presence", list);
          } else {
            io.to(collab.room).emit("group:presence", list);
            io.to(collab.room).emit("group:member-left", { displayName: collab.displayName, socketId: socket.id });
          }
        } else {
          roomParticipants.delete(collab.room);
        }

        try {
          const entry = await socket.data.collabReady;
          if (collab.clientId !== null) {
            removeAwarenessStates(entry.awareness, [collab.clientId], socket);
            const update = toBase64(encodeAwarenessUpdate(entry.awareness, [collab.clientId]));
            socket.to(collab.room).emit("collab:awareness", { update });
            socket.to(collab.room).emit("document:awareness", { update });
          }
          if (!count) {
            clearTimeout(entry.persistTimer);
            await persistDocument(collab.kind, collab.code, entry);
            scheduleIdleCleanup(collab.kind, collab.code, entry);
          }
        } catch (error) {
          if (error.code !== "COLLAB_DOCUMENT_GONE") console.error("workspace disconnect cleanup failed:", error.message);
        }
      }
    });
  });

  return {
    isOnline: (userId) => connections.has(String(userId)),
    onlineCount: () => connections.size,
    clipboardVisitorCount: (code) => roomParticipants.get(`clipboard:${normalizeClipCode(code)}`)?.size || 0
  };
}
