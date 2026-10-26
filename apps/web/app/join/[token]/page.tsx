"use client";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { loadSession } from "@/lib/session";

/** An invite link into someone's sandbox: signs the visitor in as a new guest member. */
export default function JoinPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ workspaces: Array<{ id: string }> }>("POST", "/api/auth/join", { token })
      .then(async (r) => {
        await loadSession(true);
        router.replace(`/w/${r.workspaces[r.workspaces.length - 1]?.id}`);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Couldn't join this workspace"));
  }, [token, router]);
  return error ? (
    <div className="auth">
      <header className="auth-top">
        <a className="auth-brand" href="/login">
          <span className="auth-brand-icon">🌿</span> Leaf
        </a>
      </header>
      <main className="auth-main">
        <div className="auth-col">
          <h1 className="auth-title">
            This invite has expired.
            <span>{error}</span>
          </h1>
          <a className="auth-submit auth-link-btn" href="/login">
            Try Leaf yourself
          </a>
        </div>
      </main>
    </div>
  ) : (
    <div className="splash">🌿</div>
  );
}
