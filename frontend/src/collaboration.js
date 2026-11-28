import { io } from "socket.io-client";
import * as Y from "yjs";
import {
  applyAwarenessUpdate, Awareness, encodeAwarenessUpdate
} from "y-protocols/awareness";

const SOCKET_ORIGIN = Symbol("socket");


function toBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function createRoomCollaboration({ kind = "clipboard", code, displayName, color, doc }) {
  const awareness = new Awareness(doc);
  awareness.setLocalStateField("user", { name: displayName, color });

  const client = io({
    withCredentials: true,
    autoConnect: false,
    auth: { [`${kind}Code`]: code, displayName, color, clientId: doc.clientID }
  });

  const listeners = new Map();
  const state = { status: "connecting", participants: [], error: "", deleted: false, lastSaved: null };
  const publish = (name, value) => {
    state[name] = value;
    for (const listener of listeners.get(name) || []) listener(value);
  };
  const on = (name, listener) => {
    const bucket = listeners.get(name) || new Set();
    bucket.add(listener);
    listeners.set(name, bucket);
    if (name in state) listener(state[name]);
    return () => bucket.delete(listener);
  };

  const sendAwareness = (clients) => {
    if (client.connected && clients.length) {
      const payload = { update: toBase64(encodeAwarenessUpdate(awareness, clients)) };
      client.emit("document:awareness", payload);
      client.emit("collab:awareness", payload);
    }
  };

  const onDocumentUpdate = (update, origin) => {
    if (origin !== SOCKET_ORIGIN && client.connected) {
      const payload = { update: toBase64(update) };
      client.emit("document:update", payload);
      client.emit("collab:update", payload);
    }
  };

  const onAwarenessUpdate = ({ added, updated, removed }, origin) => {
    if (origin !== SOCKET_ORIGIN) sendAwareness([...added, ...updated, ...removed]);
  };

  const onConnect = () => {
    publish("status", "connected");

    // Emit standard join events
    if (kind === "clipboard") {
      client.emit("clipboard:join", { code, displayName, color, clientId: doc.clientID });
    } else {
      client.emit("group:join", { code, displayName, color, clientId: doc.clientID });
    }

    // Request document sync
    const syncReq = { stateVector: toBase64(Y.encodeStateVector(doc)) };
    client.emit("document:sync", syncReq);
    client.emit("collab:sync-request", syncReq);

    sendAwareness([doc.clientID]);
  };

  const onSync = ({ update, serverStateVector }) => {
    try {
      Y.applyUpdate(doc, fromBase64(update), SOCKET_ORIGIN);
      const missing = Y.encodeStateAsUpdate(doc, fromBase64(serverStateVector));
      if (missing.length > 2 && client.connected) {
        const payload = { update: toBase64(missing) };
        client.emit("document:update", payload);
        client.emit("collab:update", payload);
      }
      sendAwareness([doc.clientID]);
    } catch (error) {
      publish("error", `Could not synchronize document: ${error.message}`);
    }
  };

  const onUpdate = ({ update }) => {
    try {
      Y.applyUpdate(doc, fromBase64(update), SOCKET_ORIGIN);
    } catch (error) {
      publish("error", `Could not apply a shared update: ${error.message}`);
    }
  };

  const onAwareness = ({ update }) => {
    try {
      applyAwarenessUpdate(awareness, fromBase64(update), SOCKET_ORIGIN);
    } catch (error) {
      publish("error", `Could not update collaborator cursors: ${error.message}`);
    }
  };

  doc.on("update", onDocumentUpdate);
  awareness.on("update", onAwarenessUpdate);
  client.on("connect", onConnect);
  client.on("disconnect", () => publish("status", "reconnecting"));
  client.on("connect_error", (error) => {
    publish("status", "offline");
    publish("error", `Live connection failed: ${error.message}`);
  });

  // Collaboration listeners
  client.on("document:sync", onSync);
  client.on("collab:sync", onSync);
  client.on("document:update", onUpdate);
  client.on("collab:update", onUpdate);
  client.on("document:awareness", onAwareness);
  client.on("collab:awareness", onAwareness);

  // Presence & member events
  const handlePresence = (participants) => publish("participants", participants);
  client.on("clipboard:presence", handlePresence);
  client.on("group:presence", handlePresence);
  client.on("collab:participants", handlePresence);

  client.on("collab:saved", ({ updatedAt }) => publish("lastSaved", updatedAt));
  client.on("collab:error", ({ message }) => publish("error", message));
  client.on("clipboard:update", (data) => publish("clipboardUpdated", data));
  client.on("clipboard:settings", (settings) => publish("settings", settings));
  client.on("clipboard:deleted", () => publish("deleted", true));
  client.on("group:settings", (settings) => publish("settings", settings));
  client.on("group:deleted", () => publish("deleted", true));

  client.connect();

  return {
    awareness,
    socket: client,
    on,
    saveNow() {
      if (client.connected) client.emit("collab:save");
    },
    destroy() {
      if (client.connected) {
        if (kind === "clipboard") client.emit("clipboard:leave");
        else client.emit("group:leave");

        awareness.setLocalState(null);
        sendAwareness([doc.clientID]);
      }
      doc.off("update", onDocumentUpdate);
      awareness.off("update", onAwarenessUpdate);
      client.removeAllListeners();
      client.disconnect();
      awareness.destroy();
    }
  };
}

export const createClipboardCollaboration = (options) => createRoomCollaboration({ ...options, kind: "clipboard" });
