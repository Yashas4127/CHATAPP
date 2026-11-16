import { useState } from "react";
import { Link } from "react-router-dom";
import { Lock, MessageCircle } from "lucide-react";
import { useAuth } from "../AuthContext.jsx";
import { Spinner } from "../components.jsx";

export default function AuthPage({ mode }) {
  const { login } = useAuth();
  const isLogin = mode === "login";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(mode, username.trim().replace(/^@/, ""), password);
      // GuestOnly redirects automatically once the user is set.
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-logo"><MessageCircle size={26} /></div>
        <h1>{isLogin ? "Welcome back" : "Create your account"}</h1>
        <p className="muted">{isLogin ? "Sign in with your username." : "Pick a username so people can find and message you."}</p>

        <label>
          Username
          <input
            value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required
            autoComplete="username" autoCapitalize="none" spellCheck="false" maxLength={21}
            placeholder="e.g. yashas_19"
          />
        </label>
        {!isLogin && <small className="hint">3-20 characters: letters, numbers and underscore. Not case sensitive.</small>}

        <label>
          Password
          <input
            type="password" value={password} onChange={(e) => setPassword(e.target.value)} required
            autoComplete={isLogin ? "current-password" : "new-password"} minLength={isLogin ? 1 : 8} maxLength={128}
          />
        </label>
        {!isLogin && <small className="hint">At least 8 characters.</small>}

        {error && <div className="alert">{error}</div>}

        <button className="btn primary wide" disabled={busy}>
          {busy ? <Spinner /> : isLogin ? "Sign in" : "Create account"}
        </button>

        <p className="switch">
          {isLogin ? "New here?" : "Already registered?"}{" "}
          <Link to={isLogin ? "/register" : "/login"}>{isLogin ? "Create an account" : "Sign in"}</Link>
        </p>
        <div className="auth-clipboard">
          <Link to="/clipboard/new" className="btn ghost wide">Create Clipboard</Link>
          <Link to="/clipboard" className="switch">Open a clipboard by code</Link>
        </div>
        <p className="auth-lock"><Lock size={13} /> Your messages are stored encrypted.</p>
      </form>
    </div>
  );
}
