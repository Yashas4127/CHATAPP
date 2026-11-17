import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import { api } from "./api.js";

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = still checking, null = signed out
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    api("/auth/me").then((data) => setUser(data.user)).catch(() => setUser(null));
  }, []);

  // One socket per signed-in user, closed on logout.
  useEffect(() => {
    if (!user) return undefined;
    const client = io({ withCredentials: true });
    client.on("connect", () => setConnected(true));
    client.on("disconnect", () => setConnected(false));
    setSocket(client);
    return () => {
      client.disconnect();
      setSocket(null);
      setConnected(false);
    };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const login = useCallback(async (mode, username, password) => {
    const data = await api(`/auth/${mode}`, { method: "POST", body: { username, password } });
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try { await api("/auth/logout", { method: "POST" }); } catch { /* ignore */ }
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, socket, connected, login, logout }),
    [user, socket, connected, login, logout]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
