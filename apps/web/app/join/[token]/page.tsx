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
      <div className="auth-card">
        <div className="auth-logo">🌿</div>
        <h1>Invite expired</h1>
        <p className="muted">{error}</p>
        <a className="btn primary block" href="/login">
          Try Leaf yourself
        </a>
      </div>
    </div>
  ) : (
    <div className="splash">🌿</div>
  );
}
