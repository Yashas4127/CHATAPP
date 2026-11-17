import crypto from "node:crypto";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import * as Y from "yjs";
import { config } from "./config.js";
import { Clipboard, RoomMessage } from "./models.js";

const CODE_PATTERN = /^CLP-(?:[A-Z0-9]|[A-Z0-9][A-Z0-9-]{0,22}[A-Z0-9])$/i;
const EXPIRATION_MS = {
  "10m": 10 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  never: null
};

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const ownerCookieName = (code) => `wc_clip_owner_${code}`;
const ownerCookieOptions = (code, expiration) => ({
  httpOnly: true,
  secure: config.cookieSecure,
  sameSite: "lax",
  path: "/",
  maxAge: (EXPIRATION_MS[expiration] ?? 365 * 24 * 60 * 60 * 1000) + 60_000
});
const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

function generateRandomCode() {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let suffix = "";
  const bytes = crypto.randomBytes(5);
  for (let i = 0; i < 5; i++) {
    suffix += chars[bytes[i] % chars.length];
  }
  return `CLP-${suffix}`;
}

export function normalizeClipCode(raw) {
  if (!raw) return "";
  const upper = String(raw).trim().toUpperCase();
  return upper.startsWith("CLP-") ? upper : `CLP-${upper}`;
}

function isOwner(req, clipboard) {
  const token = req.cookies?.[ownerCookieName(clipboard.code)];
  if (typeof token !== "string") return false;
  const candidate = Buffer.from(hashToken(token), "hex");
  const stored = Buffer.from(clipboard.creatorTokenHash, "hex");
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

function publicClipboard(clipboard, creator, activeVisitors = 0) {
  return {
    code: clipboard.code,
    content: clipboard.content,
    language: clipboard.language,
    permission: clipboard.permission,
    expiration: clipboard.expiration,
    expiresAt: clipboard.expiresAt?.toISOString() || null,
    revision: clipboard.revision,
    createdAt: clipboard.createdAt.toISOString(),
    updatedAt: clipboard.updatedAt.toISOString(),
    isCreator: creator,
    activeVisitors
  };
}

export function buildClipboardRouter({ io, presence }) {
  const router = express.Router();
  const createLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many clipboards created. Please try again later." }
  });
  const accessLimiter = rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many clipboard requests. Please slow down." }
  });

  const createSchema = z.object({
    code: z.string().trim().optional(),
    permission: z.enum(["readOnly", "editable"]).default("editable"),
    expiration: z.enum(["10m", "1h", "24h", "7d", "never"]).default("24h"),
    content: z.string().default(""),
    language: z.string().default("plaintext")
  });

  const updateSchema = z.object({
    permission: z.enum(["readOnly", "editable"]).optional(),
    expiration: z.enum(["10m", "1h", "24h", "7d", "never"]).optional(),
    content: z.string().optional(),
    language: z.string().optional()
  }).refine((value) => Object.keys(value).length > 0, "Provide fields to update.");

  async function findActive(code, res) {
    const clipboard = await Clipboard.findOne({ code }).select("+creatorTokenHash");
    if (!clipboard) {
      await RoomMessage.deleteMany({ roomType: "clipboard", roomCode: code });
      res.status(404).json({ error: "Clipboard not found." });
      return null;
    }
    if (clipboard.expiresAt && clipboard.expiresAt <= new Date()) {
      const room = `clipboard:${code}`;
      await Promise.all([
        clipboard.deleteOne(),
        RoomMessage.deleteMany({ roomType: "clipboard", roomCode: code })
      ]);
      io.to(room).emit("clipboard:deleted");
      io.in(room).disconnectSockets(true);
      res.status(410).json({ error: "This clipboard has expired." });
      return null;
    }
    return clipboard;
  }

  router.use(accessLimiter);

  // POST /api/clipboards or /api/clips: Create a new clipboard
  router.post("/", createLimiter, asyncRoute(async (req, res) => {
    const { code: rawCode, permission, expiration, content, language } = createSchema.parse(req.body);
    const token = crypto.randomBytes(32).toString("base64url");
    const document = new Y.Doc();
    document.getMap("meta").set("language", language || "plaintext");
    if (content) {
      document.getText("content").insert(0, content);
    }
    const documentState = Buffer.from(Y.encodeStateAsUpdate(document));
    document.destroy();

    let code = rawCode ? normalizeClipCode(rawCode) : "";
    let clipboard;

    for (let attempt = 0; attempt < 5; attempt++) {
      if (!code) {
        code = generateRandomCode();
      }
      try {
        clipboard = await Clipboard.create({
          code,
          creatorTokenHash: hashToken(token),
          content: content || "",
          language: language || "plaintext",
          permission,
          expiration,
          documentState,
          expiresAt: EXPIRATION_MS[expiration] === null ? null : new Date(Date.now() + EXPIRATION_MS[expiration])
        });
        break;
      } catch (error) {
        if (error?.code === 11000) {
          if (rawCode) {
            return res.status(409).json({ error: "That clipboard code is already in use. Choose another." });
          }
          code = ""; // retry with fresh random code
          continue;
        }
        throw error;
      }
    }

    if (!clipboard) {
      return res.status(500).json({ error: "Could not create clipboard. Please try again." });
    }

    res.cookie(ownerCookieName(clipboard.code), token, ownerCookieOptions(clipboard.code, expiration));

    // Support both client host or frontend origin
    const host = req.get("host");
    const baseOrigin = config.clientOrigin || `${req.protocol}://${host}`;
    const shareUrl = `${baseOrigin}/clip/${clipboard.code}`;

    res.status(201).json({
      clipboard: publicClipboard(clipboard, true),
      code: clipboard.code,
      shareUrl
    });
  }));

  // GET /api/clipboards/:code
  router.get("/:code", asyncRoute(async (req, res) => {
    const normalized = normalizeClipCode(req.params.code);
    if (!CODE_PATTERN.test(normalized)) {
      return res.status(400).json({ error: "Invalid clipboard code." });
    }
    const clipboard = await findActive(normalized, res);
    if (!clipboard) return;
    const isClipOwner = isOwner(req, clipboard);
    res.json({
      clipboard: publicClipboard(
        clipboard,
        isClipOwner,
        presence.clipboardVisitorCount(clipboard.code)
      )
    });
  }));

  // PATCH /api/clipboards/:code & PATCH /api/clipboards/:code/settings
  const handleUpdate = asyncRoute(async (req, res) => {
    const normalized = normalizeClipCode(req.params.code);
    if (!CODE_PATTERN.test(normalized)) {
      return res.status(400).json({ error: "Invalid clipboard code." });
    }
    const clipboard = await findActive(normalized, res);
    if (!clipboard) return;

    const changes = updateSchema.parse(req.body);
    const userIsOwner = isOwner(req, clipboard);

    // If changing permission or expiration, must be owner
    if ((changes.permission || changes.expiration) && !userIsOwner) {
      return res.status(403).json({ error: "Only the clipboard creator can change settings." });
    }

    // If changing content or language, must be editable or owner
    if ((changes.content !== undefined || changes.language !== undefined) && !userIsOwner && clipboard.permission !== "editable") {
      return res.status(403).json({ error: "This clipboard is read-only." });
    }

    if (changes.permission) clipboard.permission = changes.permission;
    if (changes.expiration) {
      clipboard.expiration = changes.expiration;
      clipboard.expiresAt = EXPIRATION_MS[changes.expiration] === null
        ? null
        : new Date(Date.now() + EXPIRATION_MS[changes.expiration]);
    }
    if (changes.content !== undefined) clipboard.content = changes.content;
    if (changes.language !== undefined) clipboard.language = changes.language;
    clipboard.revision = (clipboard.revision || 0) + 1;

    await clipboard.save();

    const room = `clipboard:${clipboard.code}`;
    const updatePayload = {
      code: clipboard.code,
      permission: clipboard.permission,
      expiration: clipboard.expiration,
      expiresAt: clipboard.expiresAt?.toISOString() || null,
      content: clipboard.content,
      language: clipboard.language,
      revision: clipboard.revision,
      updatedAt: clipboard.updatedAt.toISOString()
    };

    io.to(room).emit("clipboard:update", updatePayload);
    io.to(room).emit("clipboard:settings", updatePayload);

    const token = req.cookies?.[ownerCookieName(clipboard.code)];
    if (token) res.cookie(ownerCookieName(clipboard.code), token, ownerCookieOptions(clipboard.code, clipboard.expiration));

    res.json({
      clipboard: publicClipboard(clipboard, userIsOwner, presence.clipboardVisitorCount(clipboard.code))
    });
  });

  router.patch("/:code", handleUpdate);
  router.patch("/:code/settings", handleUpdate);

  // DELETE /api/clipboards/:code
  router.delete("/:code", asyncRoute(async (req, res) => {
    const normalized = normalizeClipCode(req.params.code);
    if (!CODE_PATTERN.test(normalized)) {
      return res.status(400).json({ error: "Invalid clipboard code." });
    }
    const clipboard = await findActive(normalized, res);
    if (!clipboard) return;
    if (!isOwner(req, clipboard)) {
      return res.status(403).json({ error: "Only the clipboard creator can delete it." });
    }
    const room = `clipboard:${clipboard.code}`;
    await Promise.all([
      clipboard.deleteOne(),
      RoomMessage.deleteMany({ roomType: "clipboard", roomCode: clipboard.code })
    ]);
    io.to(room).emit("clipboard:deleted");
    io.in(room).disconnectSockets(true);
    res.clearCookie(ownerCookieName(clipboard.code), {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: "lax",
      path: "/"
    });
    res.sendStatus(204);
  }));

  return router;
}
