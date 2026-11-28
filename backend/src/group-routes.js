import crypto from "node:crypto";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import mongoose from "mongoose";
import { config } from "./config.js";
import { groupMemberForToken, GROUP_SESSION_COOKIE, hashGuestToken, matchesGuestToken } from "./guest-sessions.js";
import { Group, Invitation, RoomMessage, WorkspaceFile, CodeExecution, ExecutionResult } from "./models.js";
import { executeCode, SUPPORTED_LANGUAGES } from "./execution-service.js";

const GROUP_CODE = /^GRP-[A-F0-9]{24}$/;
const INVITATION_MS = 7 * 24 * 60 * 60 * 1000;
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const ownerCookieOptions = {
  httpOnly: true,
  secure: config.cookieSecure,
  sameSite: "lax",
  path: "/",
  maxAge: 30 * 24 * 60 * 60 * 1000
};

export function normalizeGroupCode(value) {
  if (!value) return "";
  const raw = String(value).toUpperCase().trim();
  if (raw.startsWith("GRP-")) return raw;
  if (raw.startsWith("GP") && raw.length === 26) return `GRP-${raw.slice(2)}`;
  if (raw.length === 24 && /^[A-F0-9]{24}$/.test(raw)) return `GRP-${raw}`;
  return raw.startsWith("GRP-") ? raw : `GRP-${raw}`;
}

function publicGroup(group, member, creator) {
  const members = Array.isArray(group.members) && group.members.length
    ? group.members
    : member && creator ? [member] : [];
  return {
    id: group._id.toString(),
    code: group.code,
    name: group.name,
    description: group.description,
    memberCount: members.length,
    members: members.map((person) => ({
      id: person._id?.toString() || person.tokenHash?.slice(0, 8),
      displayName: person.displayName,
      joinedAt: person.joinedAt,
      isCreator: matchesGuestToken(person.tokenHash, group.creatorTokenHash)
    })),
    displayName: member?.displayName || "",
    isMember: Boolean(member),
    isCreator: creator,
    updatedAt: group.updatedAt.toISOString()
  };
}

export function buildGroupRouter({ io }) {
  const router = express.Router();
  const createLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many groups created. Please try again later." }
  });
  const joinLimiter = rateLimit({
    windowMs: 60_000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many invitation attempts. Please slow down." }
  });
  const createSchema = z.object({
    name: z.string().trim().min(1, "Group name is required.").max(64),
    description: z.string().trim().max(500).default(""),
    displayName: z.string().trim().min(1, "Display name is required.").max(32)
  });
  const joinSchema = z.object({
    invitation: z.string().min(1, "Invitation code is required."),
    displayName: z.string().trim().min(1, "Display name is required.").max(32)
  });
  const settingsSchema = z.object({
    name: z.string().trim().min(1).max(64).optional(),
    description: z.string().trim().max(500).optional()
  }).refine((value) => Object.keys(value).length > 0, "Choose a setting to update.");

  const ownerCookie = (code) => GROUP_SESSION_COOKIE(code);

  async function findGroup(req, res) {
    const rawParam = req.params.id || req.params.code;
    const normalized = normalizeGroupCode(rawParam);

    let query = { code: normalized };
    if (mongoose.Types.ObjectId.isValid(rawParam)) {
      query = { $or: [{ code: normalized }, { _id: rawParam }] };
    }

    const group = await Group.findOne(query).select("+creatorTokenHash");
    if (!group) {
      res.status(404).json({ error: "Group not found." });
      return null;
    }
    const token = req.cookies?.[ownerCookie(group.code)];
    const member = groupMemberForToken(group, token);
    const creator = matchesGuestToken(token, group.creatorTokenHash);
    return { group, member, creator, token };
  }

  router.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));

  // POST /api/groups - Create a group
  router.post("/", createLimiter, asyncRoute(async (req, res) => {
    const { name, description, displayName } = createSchema.parse(req.body);
    const creatorToken = crypto.randomBytes(32).toString("base64url");
    const inviteToken = crypto.randomBytes(12).toString("hex").toUpperCase();
    let group;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const code = `GRP-${crypto.randomBytes(12).toString("hex").toUpperCase()}`;
        group = await Group.create({
          code,
          name,
          description,
          creatorTokenHash: hashGuestToken(creatorToken),
          members: [{ tokenHash: hashGuestToken(creatorToken), displayName, joinedAt: new Date() }]
        });
        break;
      } catch (error) {
        if (error?.code !== 11000 || attempt === 4) throw error;
      }
    }
    if (!group) throw new Error("Could not allocate a unique group code.");

    // Seed initial default file for group
    await WorkspaceFile.create({
      group: group._id,
      groupCode: group.code,
      fileId: crypto.randomUUID(),
      name: "main.py",
      language: "python",
      content: "# Collaborative Python workspace\nprint('Hello from CodeConnect!')\n",
      isDefault: true
    });

    await Invitation.create({
      group: group._id,
      tokenHash: hashGuestToken(inviteToken),
      expiresAt: new Date(Date.now() + INVITATION_MS)
    });

    res.cookie(ownerCookie(group.code), creatorToken, ownerCookieOptions);
    const host = req.get("host");
    const baseOrigin = config.clientOrigin || `${req.protocol}://${host}`;
    const inviteUrl = `${baseOrigin}/gp${group.code.slice(4)}?invite=${inviteToken}`;

    res.status(201).json({
      group: publicGroup(group, group.members[0], true),
      code: group.code,
      inviteUrl,
      invitationCode: inviteToken
    });
  }));

  // GET /api/groups/:code or /api/groups/:id - Get group details
  router.get("/:code", asyncRoute(async (req, res) => {
    const result = await findGroup(req, res);
    if (!result) return;
    res.json({ group: publicGroup(result.group, result.member, result.creator) });
  }));

  // POST /api/groups/:code/join or /api/groups/:id/join - Join a group with invite
  router.post("/:code/join", joinLimiter, asyncRoute(async (req, res) => {
    const rawParam = req.params.code;
    const normalized = normalizeGroupCode(rawParam);
    let query = { code: normalized };
    if (mongoose.Types.ObjectId.isValid(rawParam)) {
      query = { $or: [{ code: normalized }, { _id: rawParam }] };
    }

    const { invitation, displayName } = joinSchema.parse(req.body);
    const group = await Group.findOne(query).select("+creatorTokenHash");
    if (!group) return res.status(404).json({ error: "Group not found." });

    const cleanInvite = invitation.trim().toUpperCase();
    const validInvitation = await Invitation.findOne({
      group: group._id,
      tokenHash: hashGuestToken(cleanInvite),
      revokedAt: null,
      expiresAt: { $gt: new Date() }
    });
    if (!validInvitation) {
      return res.status(403).json({ error: "This invitation is invalid, expired, or revoked." });
    }

    const sessionToken = crypto.randomBytes(32).toString("base64url");
    if (!Array.isArray(group.members) || group.members.length === 0) {
      group.members = [{
        tokenHash: group.creatorTokenHash,
        displayName: "Creator",
        joinedAt: group.createdAt
      }];
    }

    const newMember = { tokenHash: hashGuestToken(sessionToken), displayName, joinedAt: new Date() };
    group.members.push(newMember);
    await group.save();

    res.cookie(ownerCookie(group.code), sessionToken, ownerCookieOptions);

    const savedMember = group.members[group.members.length - 1];
    const groupData = publicGroup(group, savedMember, false);

    // Broadcast member joined
    io.to(`group:${group.code}`).emit("group:member-joined", {
      displayName: savedMember.displayName,
      memberCount: group.members.length,
      members: groupData.members
    });

    res.status(201).json({ group: groupData });
  }));

  // GET /api/groups/:id/members or /api/groups/:code/members - Get member list
  const handleGetMembers = asyncRoute(async (req, res) => {
    const result = await findGroup(req, res);
    if (!result) return;
    const members = (result.group.members || []).map((m) => ({
      id: m._id.toString(),
      displayName: m.displayName,
      joinedAt: m.joinedAt,
      isCreator: matchesGuestToken(m.tokenHash, result.group.creatorTokenHash)
    }));
    res.json({ members });
  });

  router.get("/:id/members", handleGetMembers);
  router.get("/:code/members", handleGetMembers);

  // DELETE /api/groups/:id/members/:userId or /api/groups/:code/members/:userId - Remove a member
  const handleRemoveMember = asyncRoute(async (req, res) => {
    const result = await findGroup(req, res);
    if (!result) return;
    if (!result.creator) {
      return res.status(403).json({ error: "Only the group creator can remove members." });
    }
    const { userId } = req.params;
    const index = result.group.members.findIndex((m) =>
      m._id.toString() === userId || m.displayName.toLowerCase() === userId.toLowerCase()
    );

    if (index === -1) {
      return res.status(404).json({ error: "Member not found." });
    }

    // Protect creator
    const target = result.group.members[index];
    if (matchesGuestToken(target.tokenHash, result.group.creatorTokenHash)) {
      return res.status(400).json({ error: "The creator cannot be removed from the group." });
    }

    result.group.members.splice(index, 1);
    await result.group.save();

    const room = `group:${result.group.code}`;
    const sockets = await io.in(room).fetchSockets();
    for (const socket of sockets) {
      if (socket.data.collab?.memberTokenHash === target.tokenHash) socket.disconnect(true);
    }
    io.to(room).emit("group:member-left", {
      userId,
      displayName: target.displayName,
      memberCount: result.group.members.length
    });

    res.json({ success: true, memberCount: result.group.members.length });
  });

  router.delete("/:id/members/:userId", handleRemoveMember);
  router.delete("/:code/members/:userId", handleRemoveMember);

  // POST /api/groups/:id/invitations or /api/groups/:code/invitations - Create new invite
  const handleCreateInvitation = asyncRoute(async (req, res) => {
    const result = await findGroup(req, res);
    if (!result) return;
    if (!result.creator) return res.status(403).json({ error: "Only the group creator can manage invitations." });

    const inviteToken = crypto.randomBytes(12).toString("hex").toUpperCase();
    const now = new Date();
    await Invitation.updateMany(
      { group: result.group._id, revokedAt: null },
      { $set: { revokedAt: now } }
    );
    const invitation = await Invitation.create({
      group: result.group._id,
      tokenHash: hashGuestToken(inviteToken),
      expiresAt: new Date(Date.now() + INVITATION_MS)
    });

    const host = req.get("host");
    const baseOrigin = config.clientOrigin || `${req.protocol}://${host}`;
    const inviteUrl = `${baseOrigin}/gp${result.group.code.slice(4)}?invite=${inviteToken}`;

    res.status(201).json({
      inviteUrl,
      invitationCode: inviteToken,
      expiresAt: invitation.expiresAt.toISOString()
    });
  });

  router.post("/:id/invitations", handleCreateInvitation);
  router.post("/:code/invitations", handleCreateInvitation);

  // DELETE /api/groups/:id/invitations or /api/groups/:code/invitations - Revoke invitations
  const handleRevokeInvitations = asyncRoute(async (req, res) => {
    const result = await findGroup(req, res);
    if (!result) return;
    if (!result.creator) return res.status(403).json({ error: "Only the group creator can revoke invitations." });

    await Invitation.updateMany(
      { group: result.group._id, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
    res.json({ success: true, message: "Invitations revoked." });
  });

  router.delete("/:id/invitations", handleRevokeInvitations);
  router.delete("/:code/invitations", handleRevokeInvitations);

  // PATCH /api/groups/:code or /api/groups/:id - Update group settings
  router.patch("/:code", asyncRoute(async (req, res) => {
    const result = await findGroup(req, res);
    if (!result) return;
    if (!result.creator) return res.status(403).json({ error: "Only the group creator can change its settings." });
    const changes = settingsSchema.parse(req.body);
    if (changes.name !== undefined) result.group.name = changes.name;
    if (changes.description !== undefined) result.group.description = changes.description;
    await result.group.save();
    io.to(`group:${result.group.code}`).emit("group:settings", {
      name: result.group.name,
      description: result.group.description,
      updatedAt: result.group.updatedAt.toISOString()
    });
    res.json({ group: publicGroup(result.group, result.member, true) });
  }));

  // ===================== WORKSPACE FILES =====================
  router.get("/:code/files", asyncRoute(async (req, res) => {
    const result = await findGroup(req, res);
    if (!result) return;
    if (!result.member) return res.status(403).json({ error: "Join the group to access files." });

    let files = await WorkspaceFile.find({ group: result.group._id }).sort({ isDefault: -1, createdAt: 1 }).lean();
    if (!files || files.length === 0) {
      const defaultFile = await WorkspaceFile.create({
        group: result.group._id,
        groupCode: result.group.code,
        fileId: crypto.randomUUID(),
        name: "main.py",
        language: "python",
        content: result.group.content || "# Collaborative Python workspace\nprint('Hello from CodeConnect!')\n",
        isDefault: true
      });
      files = [defaultFile.toObject()];
    }

    res.json({
      files: files.map((f) => ({
        id: f.fileId,
        name: f.name,
        language: f.language,
        content: f.content,
        isDefault: Boolean(f.isDefault),
        updatedAt: f.updatedAt?.toISOString() || new Date().toISOString()
      }))
    });
  }));

  router.post("/:code/files", asyncRoute(async (req, res) => {
    const result = await findGroup(req, res);
    if (!result) return;
    if (!result.member) return res.status(403).json({ error: "Join the group to add files." });

    const schema = z.object({
      name: z.string().trim().min(1).max(64).regex(/^[\w.-]+$/, "Valid file name required (letters, numbers, dots, hyphens)."),
      language: z.string().trim().default("plaintext"),
      content: z.string().max(65536).default("")
    });
    const parsed = schema.parse(req.body);

    const existingCount = await WorkspaceFile.countDocuments({ group: result.group._id });
    if (existingCount >= 20) {
      return res.status(400).json({ error: "Workspace file limit reached (max 20 files per group)." });
    }

    const file = await WorkspaceFile.create({
      group: result.group._id,
      groupCode: result.group.code,
      fileId: crypto.randomUUID(),
      name: parsed.name,
      language: parsed.language,
      content: parsed.content,
      isDefault: false
    });

    const fileJson = {
      id: file.fileId,
      name: file.name,
      language: file.language,
      content: file.content,
      isDefault: file.isDefault,
      updatedAt: file.updatedAt.toISOString()
    };

    io.to(`group:${result.group.code}`).emit("collab:file-created", fileJson);
    res.status(201).json({ file: fileJson });
  }));

  router.patch("/:code/files/:fileId", asyncRoute(async (req, res) => {
    const result = await findGroup(req, res);
    if (!result) return;
    if (!result.member) return res.status(403).json({ error: "Join the group to modify files." });

    const schema = z.object({
      name: z.string().trim().min(1).max(64).regex(/^[\w.-]+$/).optional(),
      language: z.string().trim().optional(),
      content: z.string().max(65536).optional()
    });
    const parsed = schema.parse(req.body);

    const file = await WorkspaceFile.findOne({ group: result.group._id, fileId: req.params.fileId });
    if (!file) return res.status(404).json({ error: "File not found." });

    if (parsed.name) file.name = parsed.name;
    if (parsed.language) file.language = parsed.language;
    if (parsed.content !== undefined) file.content = parsed.content;
    await file.save();

    const fileJson = {
      id: file.fileId,
      name: file.name,
      language: file.language,
      content: file.content,
      isDefault: file.isDefault,
      updatedAt: file.updatedAt.toISOString()
    };

    io.to(`group:${result.group.code}`).emit("collab:file-updated", fileJson);
    res.json({ file: fileJson });
  }));

  router.delete("/:code/files/:fileId", asyncRoute(async (req, res) => {
    const result = await findGroup(req, res);
    if (!result) return;
    if (!result.member) return res.status(403).json({ error: "Join the group to delete files." });

    const count = await WorkspaceFile.countDocuments({ group: result.group._id });
    if (count <= 1) {
      return res.status(400).json({ error: "Cannot delete the only file in the workspace." });
    }

    const deleted = await WorkspaceFile.findOneAndDelete({ group: result.group._id, fileId: req.params.fileId });
    if (!deleted) return res.status(404).json({ error: "File not found." });

    io.to(`group:${result.group.code}`).emit("collab:file-deleted", { id: req.params.fileId });
    res.sendStatus(204);
  }));

  // ===================== CODE EXECUTION =====================
  router.post("/:code/execute", asyncRoute(async (req, res) => {
    const result = await findGroup(req, res);
    if (!result) return;
    if (!result.member) return res.status(403).json({ error: "Join the group to run code." });

    const schema = z.object({
      language: z.string().trim().min(1),
      sourceCode: z.string().max(65536),
      stdin: z.string().max(65536).optional().default(""),
      fileName: z.string().trim().max(64).optional().default("main")
    });
    const { language, sourceCode, stdin, fileName } = schema.parse(req.body);

    const room = `group:${result.group.code}`;
    io.to(room).emit("collab:execution-started", {
      executedBy: result.member.displayName,
      language,
      fileName,
      startedAt: new Date().toISOString()
    });

    let executionResult;
    try {
      executionResult = await executeCode({
        groupCode: result.group.code,
        language,
        sourceCode,
        stdin,
        userToken: result.token,
        displayName: result.member.displayName
      });
    } catch (err) {
      io.to(room).emit("collab:execution-error", {
        executedBy: result.member.displayName,
        error: err.message
      });
      return res.status(err.code === "JUDGE0_UNAVAILABLE" ? 503 : 400).json({ error: err.message });
    }

    const execution = await CodeExecution.create({
      group: result.group._id,
      groupCode: result.group.code,
      fileName,
      language: executionResult.language,
      sourceCode,
      stdin,
      executedBy: result.member.displayName,
      status: executionResult.status === "Accepted" ? "completed" : "failed"
    });

    const savedResult = await ExecutionResult.create({
      execution: execution._id,
      group: result.group._id,
      groupCode: result.group.code,
      fileName,
      language: executionResult.language,
      status: executionResult.status,
      stdout: executionResult.stdout,
      stderr: executionResult.stderr,
      compileOutput: executionResult.compileOutput,
      exitCode: executionResult.exitCode,
      time: executionResult.time,
      memory: executionResult.memory,
      executedBy: result.member.displayName
    });

    const responsePayload = {
      id: savedResult._id.toString(),
      executionId: execution._id.toString(),
      status: executionResult.status,
      stdout: executionResult.stdout,
      stderr: executionResult.stderr,
      compileOutput: executionResult.compileOutput,
      exitCode: executionResult.exitCode,
      time: executionResult.time,
      memory: executionResult.memory,
      engine: executionResult.engine,
      language: executionResult.language,
      languageName: executionResult.languageName,
      fileName,
      executedBy: result.member.displayName,
      createdAt: savedResult.createdAt.toISOString()
    };

    io.to(room).emit("collab:execution-result", responsePayload);
    res.status(201).json({ result: responsePayload });
  }));

  router.get("/:code/executions", asyncRoute(async (req, res) => {
    const result = await findGroup(req, res);
    if (!result) return;
    if (!result.member) return res.status(403).json({ error: "Join the group to view executions." });

    const history = await ExecutionResult.find({ groupCode: result.group.code })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    res.json({
      executions: history.map((item) => ({
        id: item._id.toString(),
        executionId: item.execution?.toString() || "",
        status: item.status,
        stdout: item.stdout,
        stderr: item.stderr,
        compileOutput: item.compileOutput,
        exitCode: item.exitCode,
        time: item.time,
        memory: item.memory,
        language: item.language,
        fileName: item.fileName,
        executedBy: item.executedBy,
        createdAt: item.createdAt.toISOString()
      }))
    });
  }));

  // DELETE /api/groups/:code - Delete a group
  router.delete("/:code", asyncRoute(async (req, res) => {
    const result = await findGroup(req, res);
    if (!result) return;
    if (!result.creator) return res.status(403).json({ error: "Only the group creator can delete it." });
    const room = `group:${result.group.code}`;
    await Promise.all([
      result.group.deleteOne(),
      Invitation.deleteMany({ group: result.group._id }),
      RoomMessage.deleteMany({ roomType: "group", roomCode: result.group.code }),
      WorkspaceFile.deleteMany({ group: result.group._id }),
      CodeExecution.deleteMany({ group: result.group._id }),
      ExecutionResult.deleteMany({ group: result.group._id })
    ]);
    io.to(room).emit("group:deleted");
    io.in(room).disconnectSockets(true);
    res.clearCookie(ownerCookie(result.group.code), { ...ownerCookieOptions, maxAge: undefined });
    res.sendStatus(204);
  }));

  return router;
}
