import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import { Server } from "socket.io";
import { ZodError } from "zod";
import { config } from "./config.js";
import { createVault } from "./vault.js";
import { buildRouter } from "./routes.js";
import { setupSockets } from "./sockets.js";

export function createServer() {
  const app = express();
  const server = http.createServer(app);
  const allowedOrigins = new Set([
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5000",
    "http://127.0.0.1:5000",
    ...(config.clientOrigin ? [config.clientOrigin] : [])
  ]);
  const corsOptions = {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin) || config.nodeEnv === "development") {
        return callback(null, true);
      }
      return callback(new Error("CORS not allowed"), false);
    },
    credentials: true
  };

  const io = new Server(server, {
    cors: {
      origin: (origin, callback) => callback(null, true),
      credentials: true
    }
  });
  const vault = createVault(config.encryptionKey);

  if (config.trustProxy) app.set("trust proxy", 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "connect-src": ["'self'", "ws:", "wss:"],
        "upgrade-insecure-requests": null // keeps plain-http LAN/dev setups working
      }
    }
  }));
  app.use(cors(corsOptions));
  app.use(express.json({ limit: "4mb" }));
  app.use(cookieParser());

  const presence = setupSockets(io);
  app.use("/api", buildRouter({ io, vault, presence }));

  // Production: the API also serves the built frontend (one process, one URL).
  const indexHtml = path.join(config.frontendDist, "index.html");
  if (fs.existsSync(indexHtml)) {
    app.use(express.static(config.frontendDist));
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api") || req.path.startsWith("/socket.io")) return next();
      res.sendFile(indexHtml);
    });
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const missing = issue?.code === "invalid_type";
      return res.status(400).json({ error: missing ? "Please fill in all required fields." : issue?.message || "Invalid request." });
    }
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "Malformed JSON." });
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "Request is too large." });
    if (err?.code === 11000) return res.status(409).json({ error: "That already exists." });
    if (err?.name === "CastError") return res.status(400).json({ error: "Invalid identifier." });
    console.error(err);
    res.status(500).json({ error: "Unexpected server error." });
  });

  return { app, server, io };
}
