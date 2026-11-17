import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, "..", ".env") });

const env = process.env;

function fail(message) {
  console.error(`\n[config] ${message}\n`);
  process.exit(1);
}

if (!env.MONGODB_URI) fail("MONGODB_URI is missing. Run `npm run setup`, then edit backend/.env.");
if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
  fail("JWT_SECRET must be at least 32 characters. Run `npm run setup` to generate one.");
}
if (!/^[0-9a-fA-F]{64}$/.test(env.MESSAGE_ENCRYPTION_KEY || "")) {
  fail("MESSAGE_ENCRYPTION_KEY must be exactly 64 hex characters. Run `npm run setup` to generate one.");
}

export const config = {
  port: Number(env.PORT) || 5000,
  nodeEnv: env.NODE_ENV || "development",
  mongoUri: env.MONGODB_URI,
  jwtSecret: env.JWT_SECRET,
  encryptionKey: env.MESSAGE_ENCRYPTION_KEY,
  adminUsername: (env.ADMIN_USERNAME || "").trim().toLowerCase(),
  adminPassword: env.ADMIN_PASSWORD || "",
  clientOrigin: env.CLIENT_ORIGIN || "",
  cookieSecure: env.COOKIE_SECURE === "true",
  trustProxy: env.TRUST_PROXY === "true",
  dnsServers: (env.DNS_SERVERS || "").split(",").map((s) => s.trim()).filter(Boolean),
  frontendDist: path.join(here, "..", "..", "frontend", "dist"),
  judge0ApiUrl: env.JUDGE0_API_URL || "https://ce.judge0.com",
  judge0ApiKey: env.JUDGE0_API_KEY || "",
  judge0ApiHost: env.JUDGE0_API_HOST || ""
};

