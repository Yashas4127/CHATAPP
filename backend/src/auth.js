import jwt from "jsonwebtoken";
import { config } from "./config.js";
import { User } from "./models.js";

export const COOKIE_NAME = "wc_session";
export const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export const cookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: config.cookieSecure,
  path: "/",
  maxAge: SESSION_MS
};

export const signToken = (user) => jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: "7d" });

/** Returns the active user for a session token, or null. Never throws. */
export async function userFromToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const user = await User.findById(payload.sub);
    return user && !user.suspended ? user : null;
  } catch {
    return null;
  }
}

export const publicUser = (user) => ({ id: user.id, username: user.username, role: user.role });
