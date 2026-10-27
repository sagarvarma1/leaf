"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError, setShareToken } from "@/lib/api";
import { useSession } from "@/lib/session";
import { openShared } from "@/lib/store";
import { syncFor } from "@/lib/sync";
import { PageView } from "./PageView";

/** A page opened through a share link: no sidebar, access limited to the shared subtree. */
export function SharedPage({ token, pageId }: { token: string; pageId: string | null }) {
  const router = useRouter();
  const session = useSession();
  const [info, setInfo] = useState<{ pageId: string; access: "view" | "edit"; workspaceId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session.loaded) return;
    setShareToken(token);
    api<{ pageId: string; access: "view" | "edit"; workspaceId: string }>("GET", `/api/share/${token}`)
      .then((r) => {
        if (session.user && session.workspaces.some((w) => w.id === r.workspaceId)) {
          setShareToken(null);
          router.replace(`/w/${r.workspaceId}/${pageId ?? r.pageId}`);
          return;
        }
        syncFor(session.user?.id ?? null, r.workspaceId);
        openShared(r.workspaceId, token, []);
        setInfo(r);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "This link doesn't work"));
  }, [token, session.loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const nav = (e: Event) => {
      const id = (e as CustomEvent).detail as string | null;
      router.push(`/s/${token}${id ? `/${id}` : ""}`);
    };
    window.addEventListener("leaf-navigate", nav);
    return () => window.removeEventListener("leaf-navigate", nav);
  }, [token, router]);

  if (error)
    return (
      <div className="page-error">
        <div className="page-error-icon">🔗</div>
        <div>{error}</div>
      </div>
    );
  if (!info) return <div className="splash">🌿</div>;
  return (
    <div className="app shared">
      <main className="main">
        <div className="shared-banner">
          🌿 Shared with you on Leaf · {info.access === "edit" ? "can edit" : "view only"}
          {!session.user && (
            <a className="link-btn" href={`/login?next=${encodeURIComponent(`/s/${token}`)}`}>
              Log in{info.access === "edit" ? " to edit" : ""}
            </a>
          )}
        </div>
        <PageView key={pageId ?? info.pageId} pageId={pageId ?? info.pageId} workspaceId={info.workspaceId} me={session.user} share={token} />
      </main>
    </div>
  );
}
