import crypto from "node:crypto";

export const GROUP_SESSION_COOKIE = (code) => `wc_group_session_${code}`;
export const hashGuestToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

export function matchesGuestToken(token, storedHash) {
  if (typeof token !== "string" || typeof storedHash !== "string") return false;
  const candidate = Buffer.from(hashGuestToken(token), "hex");
  const expected = Buffer.from(storedHash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export function groupMemberForToken(group, token) {
  const member = (Array.isArray(group?.members) ? group.members : [])
    .find((candidate) => matchesGuestToken(token, candidate.tokenHash));
  if (member) return member;
  if (matchesGuestToken(token, group?.creatorTokenHash)) {
    return {
      tokenHash: group.creatorTokenHash,
      displayName: "Creator",
      joinedAt: group.createdAt || new Date()
    };
  }
  return null;
}
