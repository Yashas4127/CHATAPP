import mongoose from "mongoose";

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;

const userSchema = new Schema(
  {
    username: {
      type: String, required: true, unique: true, lowercase: true, trim: true,
      minlength: 3, maxlength: 20, match: /^[a-z0-9_]+$/
    },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["user", "admin"], default: "user" },
    suspended: { type: Boolean, default: false }
  },
  { timestamps: true, collection: "wc_users" }
);

const conversationSchema = new Schema(
  {
    members: { type: [{ type: ObjectId, ref: "User" }], validate: (v) => v.length === 2 },
    // "<smallerId>:<largerId>" - guarantees exactly one conversation per pair of users.
    pairKey: { type: String, required: true, unique: true },
    createdBy: { type: ObjectId, ref: "User", required: true },
    lastMessage: {
      payload: String,
      sender: { type: ObjectId, ref: "User" },
      at: Date
    },
    lastMessageAt: { type: Date, default: Date.now, index: true },
    // userId -> time they last opened the conversation (for unread counts)
    readAt: { type: Map, of: Date, default: {} }
  },
  { timestamps: true, collection: "wc_conversations" }
);
conversationSchema.index({ members: 1, lastMessageAt: -1 });

const messageSchema = new Schema(
  {
    conversation: { type: ObjectId, ref: "Conversation", required: true },
    sender: { type: ObjectId, ref: "User", required: true },
    payload: { type: String, required: true } // encrypted, see vault.js
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "wc_messages" }
);
messageSchema.index({ conversation: 1, createdAt: -1 });

const clipboardSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    creatorTokenHash: { type: String, required: true, select: false },
    content: { type: String, default: "" },
    language: { type: String, default: "plaintext" },
    permission: { type: String, enum: ["readOnly", "editable"], default: "editable" },
    expiration: { type: String, enum: ["10m", "1h", "24h", "7d", "never"], default: "24h" },
    expiresAt: { type: Date, default: null, index: true },
    deleteAfter: { type: Date, default: null, index: true },
    revision: { type: Number, default: 0 },
    documentState: { type: Buffer, default: () => Buffer.from([0, 0]) },
    documentUpdates: { type: [Buffer], default: [] }
  },
  { timestamps: true, collection: "wc_clipboards" }
);

const groupSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true, maxlength: 64 },
    description: { type: String, default: "", maxlength: 500 },
    creatorTokenHash: { type: String, required: true, select: false },
    members: [{
      tokenHash: { type: String, required: true },
      displayName: { type: String, required: true, maxlength: 32 },
      joinedAt: { type: Date, default: Date.now }
    }],
    deleteAfter: { type: Date, default: null, index: true },
    content: { type: String, default: "" },
    language: { type: String, default: "plaintext" },
    documentState: { type: Buffer, default: () => Buffer.from([0, 0]) },
    documentUpdates: { type: [Buffer], default: [] }
  },
  { timestamps: true, collection: "wc_groups" }
);

const invitationSchema = new Schema(
  {
    group: { type: ObjectId, ref: "Group", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null }
  },
  { timestamps: true, collection: "wc_invitations" }
);
invitationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const roomMessageSchema = new Schema(
  {
    roomType: { type: String, enum: ["clipboard", "group"], required: true },
    roomCode: { type: String, required: true },
    senderName: { type: String, required: true, maxlength: 32 },
    senderSession: { type: String, required: true },
    text: { type: String, default: "", maxlength: 2000 },
    attachment: {
      name: { type: String, maxlength: 128 },
      mimeType: String,
      size: Number,
      data: String
    },
    reactions: [{ emoji: String, users: [String] }]
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "wc_room_messages" }
);
roomMessageSchema.index({ roomType: 1, roomCode: 1, createdAt: -1 });

const workspaceFileSchema = new Schema(
  {
    group: { type: ObjectId, ref: "Group", required: true, index: true },
    groupCode: { type: String, required: true, index: true },
    fileId: { type: String, required: true },
    name: { type: String, required: true, maxlength: 64 },
    language: { type: String, default: "plaintext" },
    content: { type: String, default: "" },
    isDefault: { type: Boolean, default: false }
  },
  { timestamps: true, collection: "wc_workspace_files" }
);
workspaceFileSchema.index({ group: 1, fileId: 1 }, { unique: true });

const codeExecutionSchema = new Schema(
  {
    group: { type: ObjectId, ref: "Group", required: true, index: true },
    groupCode: { type: String, required: true, index: true },
    fileName: { type: String, default: "main" },
    language: { type: String, required: true },
    sourceCode: { type: String, required: true, maxlength: 65536 },
    stdin: { type: String, default: "", maxlength: 65536 },
    executedBy: { type: String, required: true },
    status: { type: String, enum: ["queued", "running", "completed", "failed", "timeout"], default: "queued" }
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "wc_code_executions" }
);
codeExecutionSchema.index({ groupCode: 1, createdAt: -1 });

const executionResultSchema = new Schema(
  {
    execution: { type: ObjectId, ref: "CodeExecution", required: true, index: true },
    group: { type: ObjectId, ref: "Group", required: true, index: true },
    groupCode: { type: String, required: true, index: true },
    fileName: { type: String, default: "main" },
    language: { type: String, required: true },
    status: { type: String, required: true },
    stdout: { type: String, default: "" },
    stderr: { type: String, default: "" },
    compileOutput: { type: String, default: "" },
    exitCode: { type: Number, default: 0 },
    time: { type: String, default: "0.000" },
    memory: { type: Number, default: 0 },
    executedBy: { type: String, required: true }
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "wc_execution_results" }
);
executionResultSchema.index({ groupCode: 1, createdAt: -1 });

export const User = mongoose.model("User", userSchema);
export const Conversation = mongoose.model("Conversation", conversationSchema);
export const Message = mongoose.model("Message", messageSchema);
export const Clipboard = mongoose.model("Clipboard", clipboardSchema);
export const Group = mongoose.model("Group", groupSchema);
export const Invitation = mongoose.model("Invitation", invitationSchema);
export const RoomMessage = mongoose.model("RoomMessage", roomMessageSchema);
export const WorkspaceFile = mongoose.model("WorkspaceFile", workspaceFileSchema);
export const CodeExecution = mongoose.model("CodeExecution", codeExecutionSchema);
export const ExecutionResult = mongoose.model("ExecutionResult", executionResultSchema);

