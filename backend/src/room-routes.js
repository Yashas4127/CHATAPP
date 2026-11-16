import express from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { groupMemberForToken, GROUP_SESSION_COOKIE } from "./guest-sessions.js";
import { Clipboard, Group, RoomMessage } from "./models.js";

const CLIPBOARD_CODE = /^CLP-(?:[A-Z0-9]|[A-Z0-9][A-Z0-9-]{0,22}[A-Z0-9])$/;
const GROUP_CODE = /^GRP-[A-F0-9]{24}$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const ALLOWED_FILE_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "application/pdf", "text/plain"]);
const ALLOWED_REACTIONS = new Set(["👍", "❤️", "😂", "🎉", "👀"]);
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const guestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

function messageJson(message) {
  return {
    id: message._id.toString(),
    senderName: message.senderName,
    text: message.text,
    attachment: message.attachment?.data ? {
      name: message.attachment.name,
      mimeType: message.attachment.mimeType,
      size: message.attachment.size,
      url: `/rooms/${message.roomType}/${encodeURIComponent(message.roomCode)}/messages/${message._id}/attachment`
    } : null,
    reactions: message.reactions.map((reaction) => ({ emoji: reaction.emoji, count: reaction.users.length })),
    createdAt: message.createdAt.toISOString()
  };
}

export function buildRoomRouter({ io }) {
  const router = express.Router();
  const sendLimiter = rateLimit({
    windowMs: 60_000,
    limit: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many chat messages. Please slow down." }
  });
  const attachmentSchema = z.object({
    name: z.string().trim().min(1).max(128),
    mimeType: z.string().max(100),
    size: z.number().int().positive().max(MAX_FILE_BYTES),
    data: z.string().max(Math.ceil(MAX_FILE_BYTES * 4 / 3) + 8)
  });
  const messageSchema = z.object({
    text: z.string().trim().max(2000).default(""),
    senderName: z.string().trim().min(1).max(32).optional(),
    guestId: guestIdSchema.optional(),
    attachment: attachmentSchema.optional()
  }).refine((value) => value.text.length > 0 || Boolean(value.attachment), "Write a message or attach a file.");

  async function resolveRoom(req, res, kind) {
    const rawCode = req.params.code.toUpperCase();
    if (kind === "clipboard") {
      if (!CLIPBOARD_CODE.test(rawCode)) {
        res.status(400).json({ error: "Invalid clipboard code." });
        return null;
      }
      const clipboard = await Clipboard.findOne({ code: rawCode }).select("expiresAt");
      if (!clipboard) {
        await RoomMessage.deleteMany({ roomType: "clipboard", roomCode: rawCode });
        res.status(404).json({ error: "Clipboard not found." });
        return null;
      }
      if (clipboard.expiresAt && clipboard.expiresAt <= new Date()) {
        await RoomMessage.deleteMany({ roomType: "clipboard", roomCode: rawCode });
        res.status(410).json({ error: "This clipboard has expired." });
        return null;
      }
      return { kind, code: rawCode, roomName: `clipboard:${rawCode}` };
    }

    if (kind !== "group" || !GROUP_CODE.test(rawCode)) {
      res.status(400).json({ error: "Invalid room code." });
      return null;
    }
    const group = await Group.findOne({ code: rawCode }).select("+creatorTokenHash");
    if (!group) {
      res.status(404).json({ error: "Group not found." });
      return null;
    }
    const token = req.cookies?.[GROUP_SESSION_COOKIE(rawCode)];
    const member = groupMemberForToken(group, token);
    if (!member) {
      res.status(403).json({ error: "Join the group with a valid invitation to access its chat." });
      return null;
    }
    return {
      kind,
      code: rawCode,
      roomName: `group:${rawCode}`,
      senderName: member.displayName,
      senderSession: member.tokenHash
    };
  }

  router.get("/:kind/:code/messages", asyncRoute(async (req, res) => {
    const room = await resolveRoom(req, res, req.params.kind);
    if (!room) return;
    const messages = await RoomMessage.find({ roomType: room.kind, roomCode: room.code })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json({ messages: messages.reverse().map(messageJson) });
  }));

  router.get("/:kind/:code/messages/:id/attachment", asyncRoute(async (req, res) => {
    const room = await resolveRoom(req, res, req.params.kind);
    if (!room) return;
    const message = await RoomMessage.findOne({
      _id: req.params.id,
      roomType: room.kind,
      roomCode: room.code
    }).select("attachment");
    if (!message?.attachment?.data) return res.status(404).json({ error: "Attachment not found." });
    res.type(message.attachment.mimeType)
      .set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(message.attachment.name)}`)
      .send(Buffer.from(message.attachment.data, "base64"));
  }));

  router.post("/:kind/:code/messages", sendLimiter, asyncRoute(async (req, res) => {
    const room = await resolveRoom(req, res, req.params.kind);
    if (!room) return;
    const input = messageSchema.parse(req.body);
    let senderName = room.senderName || input.senderName;
    let senderSession = room.senderSession || input.guestId;
    if (!senderName || !senderSession) {
      return res.status(400).json({ error: "Choose a display name before sending a message." });
    }
    let attachment;
    if (input.attachment) {
      if (!ALLOWED_FILE_TYPES.has(input.attachment.mimeType)) {
        return res.status(415).json({ error: "This file type is not supported." });
      }
      const bytes = Buffer.from(input.attachment.data, "base64");
      if (bytes.length !== input.attachment.size || bytes.length > MAX_FILE_BYTES) {
        return res.status(400).json({ error: "The attachment size is invalid or too large." });
      }
      attachment = { ...input.attachment, name: input.attachment.name.replace(/[\\/]/g, "_") };
    }
    const message = await RoomMessage.create({
      roomType: room.kind,
      roomCode: room.code,
      senderName: senderName.slice(0, 32),
      senderSession,
      text: input.text,
      attachment
    });
    const shaped = messageJson(message);
    io.to(room.roomName).emit("room:message", shaped);
    res.status(201).json({ message: shaped });
  }));

  router.patch("/:kind/:code/messages/:id/reactions", asyncRoute(async (req, res) => {
    const room = await resolveRoom(req, res, req.params.kind);
    if (!room) return;
    const input = z.object({ emoji: z.string().refine((value) => ALLOWED_REACTIONS.has(value)), guestId: guestIdSchema.optional() }).parse(req.body);
    const session = room.senderSession || input.guestId;
    if (!session) return res.status(400).json({ error: "Join the room before reacting." });
    const message = await RoomMessage.findOne({ _id: req.params.id, roomType: room.kind, roomCode: room.code });
    if (!message) return res.status(404).json({ error: "Message not found." });
    let reaction = message.reactions.find((item) => item.emoji === input.emoji);
    if (!reaction) {
      message.reactions.push({ emoji: input.emoji, users: [] });
      reaction = message.reactions.find((item) => item.emoji === input.emoji);
    }
    const users = reaction.users;
    const index = users.indexOf(session);
    if (index >= 0) users.splice(index, 1);
    else users.push(session);
    if (!users.length) message.reactions = message.reactions.filter((item) => item.emoji !== input.emoji);
    await message.save();
    const shaped = messageJson(message);
    io.to(room.roomName).emit("room:message-updated", shaped);
    res.json({ message: shaped });
  }));

  return router;
}
