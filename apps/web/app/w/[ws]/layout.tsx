"use client";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { QuickFind, SettingsModal, TrashModal } from "@/components/Overlays";
import { PageView } from "@/components/PageView";
import { createPage, Sidebar } from "@/components/Sidebar";
import { setShareToken } from "@/lib/api";
import { useSession } from "@/lib/session";
import { childPages, getState, openWorkspace, useWorkspace } from "@/lib/store";

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ ws: string; slug?: string[] }>();
  const router = useRouter();
  const session = useSession();
  const ws = params.ws;
  const pageId = params.slug?.[0] ?? null;
  const loaded = useWorkspace((s) => s.loaded && s.workspaceId === ws);
  const [sidebar, setSidebar] = useState(true);
  const [overlay, setOverlay] = useState<null | "search" | "trash" | "settings">(null);

  useEffect(() => {
    setShareToken(null);
    if (!session.loaded) return;
    if (!session.user) {
      router.replace(`/login?next=${encodeURIComponent(location.pathname)}`);
      return;
    }
    if (!session.workspaces.some((w) => w.id === ws)) {
      router.replace("/");
      return;
    }
    void openWorkspace(ws);
  }, [session.loaded, session.user, ws]); // eslint-disable-line react-hooks/exhaustive-deps

  // Land on a page when none is selected.
  useEffect(() => {
    if (!loaded || pageId) return;
    const first = childPages(getState(), null)[0];
    if (first) router.replace(`/w/${ws}/${first.id}`);
  }, [loaded, pageId, ws, router]);

  useEffect(() => {
    if (pageId) localStorage.setItem("leaf:last", JSON.stringify({ ws, page: pageId }));
  }, [ws, pageId]);

  useEffect(() => {
    const nav = (e: Event) => {
      const id = (e as CustomEvent).detail as string | null;
      router.push(id ? `/w/${ws}/${id}` : `/w/${ws}`);
    };
    const key = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "k" || e.key === "p")) {
        e.preventDefault();
        setOverlay("search");
      }
      if (mod && e.key === "\\") {
        e.preventDefault();
        setSidebar((s) => !s);
      }
      if (mod && e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void createPage(ws, null);
      }
    };
    window.addEventListener("leaf-navigate", nav);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("leaf-navigate", nav);
      window.removeEventListener("keydown", key);
    };
  }, [ws, router]);

  if (!session.user || !loaded) return <div className="splash">🌿</div>;

  return (
    <div className={`app ${sidebar ? "" : "sidebar-closed"}`}>
      {sidebar && (
        <Sidebar
          session={session}
          workspaceId={ws}
          currentId={pageId}
          onClose={() => setSidebar(false)}
          onSearch={() => setOverlay("search")}
          onTrash={() => setOverlay("trash")}
          onSettings={() => setOverlay("settings")}
        />
      )}
      <main className="main">
        {pageId ? (
          <PageView key={pageId} pageId={pageId} workspaceId={ws} me={session.user} share={null} onToggleSidebar={() => setSidebar(true)} sidebarOpen={sidebar} />
        ) : (
          <div className="empty-workspace">
            <p>No pages yet.</p>
            <button className="btn primary" onClick={() => void createPage(ws, null)}>
              Create a page
            </button>
          </div>
        )}
      </main>
      {overlay === "search" && <QuickFind workspaceId={ws} onClose={() => setOverlay(null)} />}
      {overlay === "trash" && <TrashModal onClose={() => setOverlay(null)} />}
      {overlay === "settings" && <SettingsModal workspaceId={ws} meId={session.user.id} onClose={() => setOverlay(null)} />}
      {children}
    </div>
  );
}
