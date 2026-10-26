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

  const signup = mode === "signup";
  return (
    <div className="auth">
      <header className="auth-top">
        <a className="auth-brand" href="/login">
          <span className="auth-brand-icon">🌿</span> Leaf
        </a>
        <a className="auth-top-link" href="https://github.com/sagarvarma1/leaf" target="_blank" rel="noreferrer">
          View source
        </a>
      </header>
      <main className="auth-main">
        <div className="auth-col">
          <h1 className="auth-title">
            Write, plan, together.
            <span>{signup ? "Create your Leaf account" : "Log in to your Leaf account"}</span>
          </h1>

          {demo?.guest && (
            <button className="auth-btn" disabled={busy} onClick={() => void tryIt()} data-testid="try-leaf">
              <span className="auth-btn-icon">✨</span> Try the live demo, no sign-up
            </button>
          )}
          {demo?.demoUsers !== false && (
            <>
              <button className="auth-btn" disabled={busy} onClick={() => void submit({ email: "alice@leaf.dev", password: "leafdemo" })} data-testid="demo-alice">
                <span className="avatar xs" style={{ background: "#e16259" }}>A</span> Continue as Alice (demo)
              </button>
              <button className="auth-btn" disabled={busy} onClick={() => void submit({ email: "bob@leaf.dev", password: "leafdemo" })} data-testid="demo-bob">
                <span className="avatar xs" style={{ background: "#d9730d" }}>B</span> Continue as Bob (demo)
              </button>
            </>
          )}
          {demo?.guest && <p className="auth-hint">A private copy of the demo workspace for 24 hours, with the AI collaborator. Invite a friend from the sidebar to edit together.</p>}

          {(demo?.guest || demo?.demoUsers !== false) && <div className="auth-sep" />}

          <form
            className="auth-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {signup && (
              <label className="auth-field">
                <span>Name</span>
                <input className="auth-input" placeholder="Enter your name…" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" data-testid="auth-name" />
              </label>
            )}
            <label className="auth-field">
              <span>Email</span>
              <input className="auth-input" type="email" placeholder="Enter your email address…" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" data-testid="auth-email" />
            </label>
            <label className="auth-field">
              <span>Password</span>
              <input
                className="auth-input"
                type="password"
                placeholder={signup ? "Choose a password…" : "Enter your password…"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={signup ? "new-password" : "current-password"}
                data-testid="auth-password"
              />
            </label>
            {error && <div className="auth-error">{error}</div>}
            <button className="auth-submit" disabled={busy} data-testid="auth-submit">
              {signup ? "Sign up" : "Continue"}
            </button>
          </form>

          <button className="auth-switch" onClick={() => (setMode(signup ? "login" : "signup"), setError(null))}>
            {signup ? "Have an account? Log in" : "No account? Sign up"}
          </button>
          <p className="auth-legal">Leaf is an independent project built to explore how Notion works. It isn't affiliated with Notion Labs.</p>
        </div>
      </main>
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
