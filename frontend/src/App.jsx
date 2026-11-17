import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext.jsx";
import AuthPage from "./pages/AuthPage.jsx";
import ChatPage from "./pages/ChatPage.jsx";
import AdminPage from "./pages/AdminPage.jsx";

const HomePage = lazy(() => import("./pages/HomePage.jsx"));
const ClipboardHome = lazy(() => import("./pages/ClipboardPage.jsx").then((module) => ({ default: module.ClipboardHome })));
const ClipboardEditor = lazy(() => import("./pages/ClipboardPage.jsx").then((module) => ({ default: module.ClipboardEditor })));
const GroupPage = lazy(() => import("./pages/GroupPage.jsx"));
const PageLoading = () => <div className="center-screen"><span className="spinner" /></div>;

function Protected({ children, adminOnly = false }) {
  const { user } = useAuth();
  if (user === undefined) return <div className="center-screen"><span className="spinner" /></div>;
  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly && user.role !== "admin") return <Navigate to="/chat" replace />;
  return children;
}

function GuestOnly({ children }) {
  const { user } = useAuth();
  if (user === undefined) return <div className="center-screen"><span className="spinner" /></div>;
  return user ? <Navigate to={user.role === "admin" ? "/admin" : "/chat"} replace /> : children;
}

function CatchAllRoute() {
  const location = useLocation();
  const path = location.pathname;

  // Handle /clipXXX without slash -> redirect to /clip/XXX
  if (path.startsWith("/clip") && !path.startsWith("/clipboard") && path.length > 5 && path[5] !== "/") {
    const raw = path.slice(5);
    return <Navigate to={`/clip/${raw}${location.search}`} replace />;
  }
  // Handle /gpXXX without slash -> redirect to /gp/XXX
  if (path.startsWith("/gp") && path.length > 3 && path[3] !== "/") {
    const raw = path.slice(3);
    return <Navigate to={`/gp/${raw}${location.search}`} replace />;
  }
  // Handle /groupXXX without slash -> redirect to /group/XXX
  if (path.startsWith("/group") && path.length > 6 && path[6] !== "/") {
    const raw = path.slice(6);
    return <Navigate to={`/group/${raw}${location.search}`} replace />;
  }

  return <Navigate to="/" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<GuestOnly><AuthPage mode="login" /></GuestOnly>} />
      <Route path="/register" element={<GuestOnly><AuthPage mode="register" /></GuestOnly>} />
      <Route path="/clipboard" element={<Suspense fallback={<PageLoading />}><ClipboardHome /></Suspense>} />
      <Route path="/clipboard/new" element={<Suspense fallback={<PageLoading />}><ClipboardHome /></Suspense>} />
      <Route path="/clipboards" element={<Suspense fallback={<PageLoading />}><ClipboardHome /></Suspense>} />
      <Route path="/clipboards/:code" element={<Suspense fallback={<PageLoading />}><ClipboardEditor /></Suspense>} />
      <Route path="/clip/:code" element={<Suspense fallback={<PageLoading />}><ClipboardEditor /></Suspense>} />
      <Route path="/gp/:code" element={<Suspense fallback={<PageLoading />}><GroupPage /></Suspense>} />
      <Route path="/group/:code" element={<Suspense fallback={<PageLoading />}><GroupPage /></Suspense>} />
      <Route path="/groups/:code" element={<Suspense fallback={<PageLoading />}><GroupPage /></Suspense>} />

      <Route path="/" element={<Suspense fallback={<PageLoading />}><HomePage /></Suspense>} />
      <Route path="/chat" element={<Protected><ChatPage /></Protected>} />
      <Route path="/chat/:id" element={<Protected><ChatPage /></Protected>} />
      <Route path="/admin" element={<Protected adminOnly><AdminPage /></Protected>} />
      <Route path="*" element={<CatchAllRoute />} />
    </Routes>
  );
}
