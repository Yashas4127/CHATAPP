import express from "express";
import bcrypt from "bcryptjs";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { COOKIE_NAME, cookieOptions, publicUser, signToken, userFromToken } from "./auth.js";
import { buildClipboardRouter } from "./clipboard-routes.js";
import { buildGroupRouter } from "./group-routes.js";
import { buildRoomRouter } from "./room-routes.js";
import { Conversation, Message, User } from "./models.js";

const isId = (value) => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sameId = (a, b) => String(a) === String(b);

const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,20}$/, "Username must be 3-20 characters: letters, numbers or underscore.");
const passwordSchema = z
  .string()
  .min(4, "Password must be at least 8 characters.")
  .max(128, "Password is too long.");
const messageSchema = z.object({
  text: z.string().trim().min(1, "Message is empty.").max(4000, "Message is too long (max 4000 characters).")
});

// Used so that "unknown user" and "wrong password" take the same time.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

export function buildRouter({ io, vault, presence }) {
  const router = express.Router();
  const notFound = (res, text = "Not found.") => res.status(404).json({ error: text });

  // ---------- middleware ----------
  const requireAuth = asyncRoute(async (req, res, next) => {
    const user = await userFromToken(req.cookies?.[COOKIE_NAME]);
    if (!user) return res.status(401).json({ error: "Please sign in." });
    req.user = user;
    next();
  });
  const requireAdmin = (req, res, next) =>
    req.user.role === "admin" ? next() : res.status(403).json({ error: "Administrator access required." });

  const apiLimiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false });
  const authLimiter = rateLimit({
    windowMs: 15 * 60_000, limit: 20, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false,
    message: { error: "Too many attempts. Please wait a few minutes and try again." }
  });
  const sendLimiter = rateLimit({
    windowMs: 60_000, limit: 90, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => String(req.user.id),
    message: { error: "You are sending messages too quickly." }
  });
  router.use(apiLimiter);
  const clipboardRouter = buildClipboardRouter({ io, presence });
  router.use("/clips", clipboardRouter);
  router.use("/clipboards", clipboardRouter);
  router.use("/groups", buildGroupRouter({ io }));
  router.use("/rooms", buildRoomRouter({ io }));

  // ---------- helpers ----------
  const otherMemberId = (conversation, meId) => conversation.members.find((m) => !sameId(m, meId));

  const shapeMessage = (message, text) => ({
    id: message._id.toString(),
    conversationId: message.conversation.toString(),
    senderId: message.sender.toString(),
    text: text ?? vault.decrypt(message.payload, message.conversation.toString()),
    createdAt: new Date(message.createdAt).toISOString()
  });

  async function describeConversations(conversations, meId) {
    const otherIds = conversations.map((c) => otherMemberId(c, meId));
    const users = await User.find({ _id: { $in: otherIds } }).select("username").lean();
    const byId = new Map(users.map((u) => [u._id.toString(), u]));
    return Promise.all(conversations.map(async (c) => {
      const otherId = otherMemberId(c, meId).toString();
      const readAt = c.readAt instanceof Map ? c.readAt.get(meId) : c.readAt?.[meId];
      const unread = await Message.countDocuments({
        conversation: c._id, sender: { $ne: meId }, createdAt: { $gt: readAt || new Date(0) }
      });
      return {
        id: c._id.toString(),
        other: { id: otherId, username: byId.get(otherId)?.username || "deleted_user", online: presence.isOnline(otherId) },
        lastMessage: c.lastMessage?.at
          ? { text: vault.decrypt(c.lastMessage.payload, c._id.toString()), at: new Date(c.lastMessage.at).toISOString(), mine: sameId(c.lastMessage.sender, meId) }
          : null,
        lastMessageAt: new Date(c.lastMessageAt).toISOString(),
        unread
      };
    }));
  }

  /** Conversation the signed-in user belongs to, or null. Admins get no special access here. */
  async function findMine(req) {
    if (!isId(req.params.id)) return null;
    const conversation = await Conversation.findById(req.params.id);
    return conversation && conversation.members.some((m) => sameId(m, req.user.id)) ? conversation : null;
  }

  async function loadMessages(conversationId, before, limit) {
    const filter = { conversation: conversationId };
    const beforeDate = before ? new Date(before) : null;
    if (beforeDate && !Number.isNaN(beforeDate.getTime())) filter.createdAt = { $lt: beforeDate };
    const messages = await Message.find(filter).sort({ createdAt: -1 }).limit(limit);
    return messages.reverse().map((m) => shapeMessage(m));
  }

  const emitToMembers = (conversation, event, payload) => {
    for (const member of conversation.members) io.to(`user:${member}`).emit(event, payload);
  };
  const emitToAdminViewer = (conversation, event, payload) => {
    io.to(`admin:conversation:${conversation.id}`).emit(event, payload);
    io.to("admin:overview").emit("admin:conversation-updated", { conversationId: conversation.id });
  };

  // ---------- health ----------
  router.get("/health", (_req, res) => res.json({ status: "ok" }));

  // ---------- auth ----------
  router.post("/auth/register", authLimiter, asyncRoute(async (req, res) => {
    const data = z.object({ username: usernameSchema, password: passwordSchema }).parse(req.body);
    if (await User.exists({ username: data.username })) return res.status(409).json({ error: "That username is already taken." });
    const user = await User.create({ username: data.username, passwordHash: await bcrypt.hash(data.password, 12) });
    res.cookie(COOKIE_NAME, signToken(user), cookieOptions).status(201).json({ user: publicUser(user) });
  }));

  router.post("/auth/login", authLimiter, asyncRoute(async (req, res) => {
    const data = z.object({ username: usernameSchema, password: z.string().min(1, "Password is required.").max(128) }).parse(req.body);
    const user = await User.findOne({ username: data.username });
    const valid = await bcrypt.compare(data.password, user ? user.passwordHash : DUMMY_HASH);
    if (!user || !valid) return res.status(401).json({ error: "Username or password is incorrect." });
    if (user.suspended) return res.status(403).json({ error: "This account has been suspended." });
    res.cookie(COOKIE_NAME, signToken(user), cookieOptions).json({ user: publicUser(user) });
  }));

  router.post("/auth/logout", (_req, res) => {
    res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: undefined }).sendStatus(204);
  });

  router.get("/auth/me", requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

  // ---------- find people ----------
  router.get("/users/search", requireAuth, asyncRoute(async (req, res) => {
    const { q } = z.object({ q: z.string().trim().toLowerCase().min(1).max(20) }).parse(req.query);
    const users = await User.find({
      username: { $regex: `^${escapeRegex(q)}` }, suspended: false, _id: { $ne: req.user._id }
    }).select("username").sort({ username: 1 }).limit(8).lean();
    res.json({ users: users.map((u) => ({ id: u._id.toString(), username: u.username })) });
  }));

  // ---------- conversations ----------
  router.post("/conversations", requireAuth, asyncRoute(async (req, res) => {
    const { username } = z.object({ username: usernameSchema }).parse(req.body);
    const target = await User.findOne({ username, suspended: false });
    if (!target) return notFound(res, `No user named "${username}".`);
    if (target.id === req.user.id) return res.status(400).json({ error: "You cannot start a chat with yourself." });

    const pairKey = [req.user.id, target.id].sort().join(":");
    let conversation = await Conversation.findOne({ pairKey });
    if (!conversation) {
      try {
        conversation = await Conversation.create({ members: [req.user._id, target._id], pairKey, createdBy: req.user._id });
      } catch (error) {
        if (error?.code !== 11000) throw error;
        conversation = await Conversation.findOne({ pairKey }); // created by a parallel request
      }
    }
    const [described] = await describeConversations([conversation.toObject()], req.user.id);
    res.status(201).json({ conversation: described });
  }));

  router.get("/conversations", requireAuth, asyncRoute(async (req, res) => {
    const conversations = await Conversation.find({
      members: req.user._id,
      $or: [{ "lastMessage.at": { $exists: true } }, { createdBy: req.user._id }]
    }).sort({ lastMessageAt: -1 }).limit(200).lean();
    res.json({ conversations: await describeConversations(conversations, req.user.id) });
  }));

  router.get("/conversations/:id", requireAuth, asyncRoute(async (req, res) => {
    const conversation = await findMine(req);
    if (!conversation) return notFound(res, "Conversation not found.");
    const [described] = await describeConversations([conversation.toObject()], req.user.id);
    res.json({ conversation: described });
  }));

  router.get("/conversations/:id/messages", requireAuth, asyncRoute(async (req, res) => {
    const conversation = await findMine(req);
    if (!conversation) return notFound(res, "Conversation not found.");
    res.json({ messages: await loadMessages(conversation._id, req.query.before, 100) });
  }));

  router.post("/conversations/:id/messages", requireAuth, sendLimiter, asyncRoute(async (req, res) => {
    const { text } = messageSchema.parse(req.body);
    const conversation = await findMine(req);
    if (!conversation) return notFound(res, "Conversation not found.");
    const otherId = otherMemberId(conversation, req.user.id);
    const other = await User.findById(otherId).select("username suspended");
    if (!other || other.suspended) return res.status(403).json({ error: "This user is no longer available." });

    const conversationId = conversation.id;
    const message = await Message.create({
      conversation: conversation._id, sender: req.user._id, payload: vault.encrypt(text, conversationId)
    });
    await Conversation.updateOne({ _id: conversation._id }, {
      $set: {
        lastMessage: { payload: message.payload, sender: req.user._id, at: message.createdAt },
        lastMessageAt: message.createdAt,
        [`readAt.${req.user.id}`]: message.createdAt
      }
    });

    const shaped = shapeMessage(message, text);
    emitToMembers(conversation, "message:new", { conversationId, message: shaped });
    emitToAdminViewer(conversation, "admin:message", { conversationId, message: shaped });
    res.status(201).json({ message: shaped });
  }));

  router.post("/conversations/:id/read", requireAuth, asyncRoute(async (req, res) => {
    const conversation = await findMine(req);
    if (!conversation) return notFound(res, "Conversation not found.");
    await Conversation.updateOne({ _id: conversation._id }, { $set: { [`readAt.${req.user.id}`]: new Date() } });
    res.sendStatus(204);
  }));

  router.delete("/messages/:id", requireAuth, asyncRoute(async (req, res) => {
    if (!isId(req.params.id)) return notFound(res, "Message not found.");
    const message = await Message.findById(req.params.id);
    if (!message) return res.sendStatus(204);
    if (!sameId(message.sender, req.user.id)) return res.status(403).json({ error: "You can only delete your own messages." });

    const conversation = await Conversation.findById(message.conversation);
    await message.deleteOne();
    if (conversation) {
      const latest = await Message.findOne({ conversation: conversation._id }).sort({ createdAt: -1 });
      if (latest) {
        await Conversation.updateOne({ _id: conversation._id }, {
          $set: { lastMessage: { payload: latest.payload, sender: latest.sender, at: latest.createdAt }, lastMessageAt: latest.createdAt }
        });
      } else {
        await Conversation.updateOne({ _id: conversation._id }, { $unset: { lastMessage: 1 }, $set: { lastMessageAt: conversation.createdAt } });
      }
      const payload = { conversationId: conversation.id, messageId: message.id };
      emitToMembers(conversation, "message:deleted", payload);
      emitToAdminViewer(conversation, "admin:message-deleted", payload);
    }
    res.sendStatus(204);
  }));

  // ---------- admin ----------
  const admin = express.Router();
  admin.use(requireAuth, requireAdmin);

  admin.get("/stats", asyncRoute(async (_req, res) => {
    const [users, conversations] = await Promise.all([
      User.countDocuments(), Conversation.countDocuments({ "lastMessage.at": { $exists: true } })
    ]);
    res.json({ users, conversations, online: presence.onlineCount() });
  }));

  admin.get("/conversations", asyncRoute(async (_req, res) => {
    const conversations = await Conversation.find({ "lastMessage.at": { $exists: true } })
      .select("members lastMessageAt")
      .sort({ lastMessageAt: -1 })
      .limit(500)
      .lean();
    const users = await User.find({ _id: { $in: conversations.flatMap((item) => item.members) } })
      .select("username")
      .lean();
    const byId = new Map(users.map((item) => [item._id.toString(), item.username]));
    res.json({
      conversations: conversations.map((item) => ({
        id: item._id.toString(),
        members: item.members.map((member) => ({
          id: member.toString(),
          username: byId.get(member.toString()) || "deleted_user"
        })),
        lastMessageAt: item.lastMessageAt.toISOString()
      }))
    });
  }));

  admin.get("/conversations/:id/messages", asyncRoute(async (req, res) => {
    if (!isId(req.params.id)) return notFound(res, "Conversation not found.");
    const conversation = await Conversation.findById(req.params.id).select("_id");
    if (!conversation) return notFound(res, "Conversation not found.");
    res.json({ messages: await loadMessages(conversation._id, req.query.before, 100) });
  }));

  admin.get("/users", asyncRoute(async (_req, res) => {
    const [users, conversations] = await Promise.all([
      User.find().select("username role suspended createdAt").sort({ username: 1 }).lean(),
      Conversation.find({ "lastMessage.at": { $exists: true } }).select("members").lean()
    ]);
    const userIds = users.map((u) => u._id.toString());
    const userById = new Map(users.map((u) => [u._id.toString(), u]));
    const partnersByUser = new Map(userIds.map((id) => [id, new Set()]));
    for (const conversation of conversations) {
      const [first, second] = conversation.members.map((member) => member.toString());
      if (partnersByUser.has(first) && partnersByUser.has(second)) {
        partnersByUser.get(first).add(second);
        partnersByUser.get(second).add(first);
      }
    }
    res.json({
      users: users.map((u) => ({
        id: u._id.toString(), username: u.username, role: u.role, suspended: u.suspended,
        createdAt: u.createdAt, online: presence.isOnline(u._id),
        chattedWith: [...(partnersByUser.get(u._id.toString()) || [])]
          .map((id) => userById.get(id))
          .filter(Boolean)
          .map((partner) => ({ id: partner._id.toString(), username: partner.username }))
      }))
    });
  }));

  admin.patch("/users/:id", asyncRoute(async (req, res) => {
    const { suspended } = z.object({ suspended: z.boolean() }).parse(req.body);
    if (!isId(req.params.id)) return notFound(res, "User not found.");
    const user = await User.findById(req.params.id);
    if (!user) return notFound(res, "User not found.");
    if (user.role === "admin") return res.status(400).json({ error: "Administrator accounts cannot be suspended." });
    user.suspended = suspended;
    await user.save();
    if (suspended) io.in(`user:${user.id}`).disconnectSockets(true);
    res.json({ user: { id: user.id, username: user.username, role: user.role, suspended: user.suspended } });
  }));

  router.use("/admin", admin);
  router.use((_req, res) => notFound(res, "Unknown API route."));
  return router;
}
