"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { loadSession } from "@/lib/session";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState<{ guest: boolean; demoUsers: boolean } | null>(null);
  useEffect(() => {
    api<{ guest: boolean; demoUsers: boolean }>("GET", "/api/demo")
      .then(setDemo)
      .catch(() => setDemo({ guest: false, demoUsers: true }));
  }, []);

  /** "Try Leaf": a private sandbox copy of the demo workspace, no sign-up. */
  const tryIt = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ workspaces: Array<{ id: string }> }>("POST", "/api/auth/guest");
      await loadSession(true);
      router.replace(`/w/${r.workspaces[0]?.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong");
      setBusy(false);
    }
  };

  const submit = async (creds?: { email: string; password: string }) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ workspaces: Array<{ id: string }> }>(
        "POST",
        mode === "signup" && !creds ? "/api/auth/signup" : "/api/auth/login",
        creds ?? (mode === "signup" ? { email, name, password } : { email, password }),
      );
      await loadSession(true);
      const next = params.get("next");
      router.replace(next && next.startsWith("/") ? next : `/w/${r.workspaces[0]?.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong");
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-logo">🌿</div>
        <h1>{mode === "login" ? "Log in to Leaf" : "Create your Leaf account"}</h1>
        <p className="muted">A small Notion, rebuilt from scratch.</p>
        {demo?.guest && (
          <div className="auth-try">
            <button className="btn primary block try-btn" disabled={busy} onClick={() => void tryIt()} data-testid="try-leaf">
              Try Leaf now: no sign-up
            </button>
            <div className="muted small">You get a private copy of the demo workspace for 24 hours, with an AI collaborator. Invite a friend from the sidebar to edit together.</div>
            <div className="auth-or">or log in</div>
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {mode === "signup" && <input className="input" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} data-testid="auth-name" />}
          <input className="input" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" data-testid="auth-email" />
          <input className="input" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} data-testid="auth-password" />
          {error && <div className="auth-error">{error}</div>}
          <button className="btn primary block" disabled={busy} data-testid="auth-submit">
            {mode === "login" ? "Continue" : "Sign up"}
          </button>
        </form>
        <button className="link-btn" onClick={() => (setMode(mode === "login" ? "signup" : "login"), setError(null))}>
          {mode === "login" ? "No account? Sign up" : "Have an account? Log in"}
        </button>
        {demo?.demoUsers !== false && (
        <div className="auth-demo">
          <div className="muted small">Demo accounts (password: leafdemo)</div>
          <div className="row">
            <button className="btn block" disabled={busy} onClick={() => void submit({ email: "alice@leaf.dev", password: "leafdemo" })} data-testid="demo-alice">
              <span className="avatar xs" style={{ background: "#e16259" }}>A</span> Alice
            </button>
            <button className="btn block" disabled={busy} onClick={() => void submit({ email: "bob@leaf.dev", password: "leafdemo" })} data-testid="demo-bob">
              <span className="avatar xs" style={{ background: "#d9730d" }}>B</span> Bob
            </button>
          </div>
          <div className="muted small">Tip: open Bob in a private window to collaborate with Alice side by side.</div>
        </div>
        )}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="splash">🌿</div>}>
      <LoginForm />
    </Suspense>
  );
}
