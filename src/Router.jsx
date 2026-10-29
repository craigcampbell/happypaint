import { Component, Suspense, lazy, useCallback, useEffect, useState } from "react";
import HomePage from "./components/HomePage";
import { getCommunityEvent } from "./data/communityEvents";
import { getPageSeo } from "./data/discoverySeo";

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
const RoomRadar = lazy(() => import("./components/RoomRadar"));
const AdminUsers = lazy(() => import("./components/AdminUsers"));
const AdminCurator = lazy(() => import("./components/AdminCurator"));
const AdminGallery = lazy(() => import("./components/AdminGallery"));
const RoomWatch = lazy(() => import("./components/RoomWatch"));
const PublicWatch = lazy(() => import("./components/PublicWatch"));
const WallPage = lazy(() => import("./components/WallPage"));
const InktoberPage = lazy(() => import("./components/InktoberPage"));
const SketchbookPage = lazy(() => import("./components/SketchbookPage"));
const SketchbookStartPage = lazy(() => import("./components/SketchbookStartPage"));
const SketchbookInvitePage = lazy(() => import("./components/SketchbookInvitePage"));
const PlanetPage = lazy(() => import("./components/PlanetPage"));
const ArtistGalleryRoute = lazy(() => import("./components/ArtistGalleryRoute"));
const DiscoveryPage = lazy(() => import("./components/DiscoveryPage"));
const CommunityEventPage = lazy(() => import("./components/CommunityEventPage"));

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
  // Pages key on path+search so a query-only navigation (e.g. /gallery?event=
  // inktober-2026 → plain /gallery from the nav) remounts with fresh state
  // instead of silently keeping the previous page's filters.
  const [locKey, setLocKey] = useState(() => window.location.pathname + window.location.search);
  const navigate = useCallback((nextPath) => {
    window.history.pushState({}, "", nextPath);
    setPath(window.location.pathname);
    setLocKey(window.location.pathname + window.location.search);
    window.scrollTo({ top: 0, behavior: "instant" });
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      setPath(window.location.pathname);
      setLocKey(window.location.pathname + window.location.search);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    const meta = getPageSeo(path);
    // Dynamic artwork pages keep their server-provided share metadata on a
    // direct load. On SPA navigation they still get their own canonical URL.
    if (!meta) {
      const privatePath = /^\/(?:admin|watch|join|sketchbook)(?:\/|$)/.test(path);
      const canonical = document.querySelector('[data-seo="canonical"]');
      canonical?.setAttribute("href", `https://drawesome.art${privatePath ? "/" : path}`);
      return;
    }
    document.title = meta.title;
    const set = (marker, attr, value) => document.querySelector(`[data-seo="${marker}"]`)?.setAttribute(attr, value);
    set("desc", "content", meta.description);
    set("og:title", "content", meta.title);
    set("tw:title", "content", meta.title);
    set("og:desc", "content", meta.description);
    set("tw:desc", "content", meta.description);
    set("canonical", "href", `https://drawesome.art${meta.path === "/" ? "/" : meta.path}`);
    set("og:url", "content", `https://drawesome.art${meta.path === "/" ? "/" : meta.path}`);
  }, [path]);

  let page;
  const drawing = path === "/draw" || path.startsWith("/studio") || path.startsWith("/join");
  if (path === "/draw") {
    const event = getCommunityEvent(new URLSearchParams(window.location.search).get("event"));
    page = <StudioApp key={`local-${event?.id || "solo"}`} initialLocal initialEvent={event?.id || ""} initialPrompt={(new URLSearchParams(window.location.search).get("prompt") || event?.prompt || "").slice(0, 180)} />;
  } else if (path.startsWith("/studio") && !path.startsWith("/studios")) {
    const prompt = (new URLSearchParams(window.location.search).get("prompt") || "").slice(0, 180);
    page = <StudioApp key="room-MAIN" initialPrompt={prompt} />;
  } else if (path.startsWith("/join")) {
    const code = (path.split("/")[2] || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "MAIN";
    // A new room must get a fresh canvas, socket, and undo history.
    page = <StudioApp key={`room-${code}`} initialJoinCode={code} />;
  } else if (path.startsWith("/watch")) {
    // The admin glass-room. Not a drawing route: no studio bundle, no canvas
    // tools, the watch view is read-only by construction.
    const code = (path.split("/")[2] || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
    page = <RoomWatch key={`watch-${code}`} roomCode={code} onNavigate={navigate} />;
  } else if (path.startsWith("/live")) {
    // The public read-only watch page: a shareable window into one public room's
    // mural. Not a drawing route either, it renders the spectator socket client
    // and nothing that can send, so no studio bundle is pulled in.
    const code = (path.split("/")[2] || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "MAIN";
    page = <PublicWatch key={`live-${code}`} roomCode={code} onNavigate={navigate} />;
  } else if (path.startsWith("/admin")) {
    // Three consoles, three pages: the original overview (/admin), the room
    // radar (/admin/rooms) and the user + gallery inspectors. Each is its own
    // lazy chunk so a moderator only pays for the page they open.
    if (path === "/admin/curator") {
      page = <AdminCurator onNavigate={navigate} />;
    } else if (path.startsWith("/admin/rooms")) {
      page = <RoomRadar onNavigate={navigate} />;
    } else if (path.startsWith("/admin/users")) {
      page = <AdminUsers onNavigate={navigate} />;
    } else if (path.startsWith("/admin/gallery")) {
      page = <AdminGallery onNavigate={navigate} />;
    } else {
      page = <LiveAdmin onNavigate={navigate} />;
    }
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
  } else if (path === "/studios") {
    page = <ArtistGalleryRoute onNavigate={navigate} />;
  } else if (path.startsWith("/gallery")) {
    page = <DiscoveryPage onNavigate={navigate} />;
  } else if (path === "/events") {
    page = <DiscoveryPage onNavigate={navigate} initialTab="events" />;
  } else if (path.startsWith("/events/")) {
    page = <CommunityEventPage onNavigate={navigate} eventId={path.split("/")[2] || ""} />;
  } else if (path.startsWith("/wall")) {
    page = <WallPage onNavigate={navigate} initialPostId={(path.split("/")[2] || "").slice(0, 64)} />;
  } else if (path.startsWith("/sketchbook/invite/")) {
    // Invitation acceptance: the token rides the URL (its only client-side
    // home besides the owner's one-time mint view).
    const token = decodeURIComponent(path.split("/")[3] || "").slice(0, 96);
    page = <SketchbookInvitePage token={token} onNavigate={navigate} />;
  } else if (path.startsWith("/sketchbook/")) {
    // The public book reader, anyone may flip through; drawing stays ACL'd.
    const id = (path.split("/")[2] || "").replace(/[^a-z0-9_]/gi, "").slice(0, 24);
    page = <SketchbookPage key={`skb-${id}`} bookId={id} onNavigate={navigate} />;
  } else if (path.startsWith("/sketchbook")) {
    // Own-sketchbook entry: create/resume with the sign-in return path.
    page = <SketchbookStartPage onNavigate={navigate} />;
  } else if (path.startsWith("/inktober")) {
    page = <InktoberPage onNavigate={navigate} />;
  } else if (path.startsWith("/planet") || path.startsWith("/paintjar")) {
    // /paintjar is the old name; both land on the Painted Planet.
    page = <PlanetPage onNavigate={navigate} />;
  } else {
    page = <HomePage onNavigate={navigate} />;
  }

  return (
    <RouteErrorBoundary key={locKey}>
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
