import { Component, Suspense, lazy, useCallback, useEffect, useState } from "react";
import HomePage from "./components/HomePage";

// Visiting a guide or the homepage should not download the drawing studio,
// its tools, billing UI, or the admin console. Each route loads when needed.
const StudioApp = lazy(() => import("./App"));
const AboutPage = lazy(() => import("./components/AboutPage"));
const PrivacyPage = lazy(() => import("./components/PrivacyPage"));
const SignupPage = lazy(() => import("./components/SignupPage"));
const RoomFinderPage = lazy(() => import("./components/RoomFinderPage"));
const SafetyPage = lazy(() => import("./components/SafetyPage"));
const ParentsPage = lazy(() => import("./components/ParentsPage"));
const FamilyPage = lazy(() => import("./components/FamilyPage"));
const FaqPage = lazy(() => import("./components/FaqPage"));
const LiveAdmin = lazy(() => import("./components/LiveAdmin"));
const WallPage = lazy(() => import("./components/WallPage"));

class RouteErrorBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="route-status">
        <h1>This page couldn’t load</h1>
        <p>Check your connection, then try again.</p>
        <button type="button" className="primary-action" onClick={() => window.location.reload()}>Try again</button>
        <a href="/">Back to Drawesome</a>
      </main>
    );
  }
}

export default function Router() {
  const [path, setPath] = useState(() => window.location.pathname);
  const navigate = useCallback((nextPath) => {
    window.history.pushState({}, "", nextPath);
    setPath(window.location.pathname);
    window.scrollTo({ top: 0, behavior: "instant" });
  }, []);

  useEffect(() => {
    const handlePopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  let page;
  const drawing = path.startsWith("/studio") || path.startsWith("/join");
  if (path.startsWith("/studio")) {
    const prompt = (new URLSearchParams(window.location.search).get("prompt") || "").slice(0, 180);
    page = <StudioApp key="room-MAIN" initialPrompt={prompt} />;
  } else if (path.startsWith("/join")) {
    const code = (path.split("/")[2] || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "MAIN";
    // A new room must get a fresh canvas, socket, and undo history.
    page = <StudioApp key={`room-${code}`} initialJoinCode={code} />;
  } else if (path.startsWith("/admin")) {
    page = <LiveAdmin onNavigate={navigate} />;
  } else if (path.startsWith("/safety")) {
    page = <SafetyPage onNavigate={navigate} />;
  } else if (path.startsWith("/parents")) {
    page = <ParentsPage onNavigate={navigate} />;
  } else if (path.startsWith("/family")) {
    page = <FamilyPage onNavigate={navigate} />;
  } else if (path.startsWith("/faq")) {
    page = <FaqPage onNavigate={navigate} />;
  } else if (path.startsWith("/about")) {
    page = <AboutPage onNavigate={navigate} />;
  } else if (path.startsWith("/privacy")) {
    page = <PrivacyPage onNavigate={navigate} />;
  } else if (path.startsWith("/signup")) {
    page = <SignupPage onNavigate={navigate} />;
  } else if (path.startsWith("/rooms")) {
    page = <RoomFinderPage onNavigate={navigate} />;
  } else if (path.startsWith("/wall")) {
    page = <WallPage onNavigate={navigate} initialPostId={(path.split("/")[2] || "").slice(0, 64)} />;
  } else {
    page = <HomePage onNavigate={navigate} />;
  }

  return (
    <RouteErrorBoundary key={path}>
      <Suspense fallback={(
        <main className="route-status" role="status" aria-live="polite">
          <h1>{drawing ? "Opening your canvas…" : "Opening Drawesome…"}</h1>
          <p>One moment while this page loads.</p>
          <a href="/">Back to Drawesome</a>
        </main>
      )}>
        {page}
      </Suspense>
    </RouteErrorBoundary>
  );
}
