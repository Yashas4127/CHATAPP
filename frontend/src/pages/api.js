// Tiny fetch wrapper. All requests are same-origin (/api/...), cookies included.
export async function api(path, { method = "GET", body } = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: "include",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    throw Object.assign(new Error("Cannot reach the server. Check your connection."), { status: 0 });
  }
  if (response.status === 204) return null;

  let data = null;
  try { data = await response.json(); } catch { /* non-JSON body */ }

  if (!response.ok) {
    const fallback = response.status >= 500
      ? "The server is not responding. Make sure the backend is running."
      : `Request failed (${response.status}).`;
    throw Object.assign(new Error(data?.error || fallback), { status: response.status, data });
  }
  return data;
}

export const ENCRYPTION_NOTE =
  "Messages are encrypted in transit (HTTPS) and stored encrypted (AES-256-GCM). " +
  "They are readable only by the two people in the chat.";

export function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatDay(iso) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

export function formatShort(iso) {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString()
    ? formatTime(iso)
    : date.toLocaleDateString([], { day: "numeric", month: "short" });
}
