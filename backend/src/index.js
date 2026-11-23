import dns from "node:dns";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { config } from "./config.js";
import { Clipboard, User } from "./models.js";
import { createServer } from "./server.js";

if (config.dnsServers.length) {
  try {
    dns.setServers(config.dnsServers);
  } catch (dnsErr) {
    console.warn("Could not set custom DNS servers:", dnsErr.message);
  }
}

async function connectDatabase() {
  try {
    await mongoose.connect(config.mongoUri, {
      serverSelectionTimeoutMS: 20_000,
      socketTimeoutMS: 45_000,
      connectTimeoutMS: 20_000,
      maxPoolSize: 10,
      family: 4
    });
    console.log("MongoDB connected.");
  } catch (error) {
    console.error("\nCould not connect to MongoDB:", error.message);
    console.error("  - Continuing without a DB – some features may be unavailable.");
    // Do not exit; allow the server to start for front‑end testing.
  }
}

async function removeClipboardExpirationTtl() {
  const collectionExists = await mongoose.connection.db
    .listCollections({ name: Clipboard.collection.collectionName }, { nameOnly: true })
    .hasNext();
  if (!collectionExists) return;
  const indexes = await Clipboard.collection.indexes();
  const ttlIndex = indexes.find((index) => index.key?.expiresAt === 1 && index.expireAfterSeconds !== undefined);
  if (!ttlIndex) return;
  await Clipboard.collection.dropIndex(ttlIndex.name);
  await Clipboard.createIndexes();
  console.log("Updated clipboard expiration cleanup to preserve associated room data.");
}

async function seedAdmin() {
  const { adminUsername: username, adminPassword: password } = config;
  if (!username || !password) {
    console.warn("ADMIN_USERNAME / ADMIN_PASSWORD not set - no admin account was created.");
    return;
  }
  if (!/^[a-z0-9_]{3,20}$/.test(username) || password.length < 8) {
    console.warn("ADMIN_USERNAME must be 3-20 letters/numbers/underscores and ADMIN_PASSWORD at least 8 characters - admin not created.");
    return;
  }
  const existing = await User.findOne({ username });
  if (!existing) {
    await User.create({ username, passwordHash: await bcrypt.hash(password, 12), role: "admin" });
    console.log(`Admin account "${username}" created.`);
  } else if (existing.role !== "admin") {
    console.warn(`A normal user named "${username}" already exists, so no admin was created. Use a different ADMIN_USERNAME.`);
  }
}

await connectDatabase();
await removeClipboardExpirationTtl();
await seedAdmin();

const { server } = createServer();
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") console.error(`Port ${config.port} is already in use. Change PORT in backend/.env or stop the other process.`);
  else console.error(error);
  process.exit(1);
});
server.listen(config.port,"0.0.0.0", () => console.log(`WebChat API listening on http://localhost:${config.port}`));
// server.listen(3000, "0.0.0.0", () => {
//     console.log("Server running on port 3000");
// });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    mongoose.disconnect().finally(() => process.exit(0));
  });
}
