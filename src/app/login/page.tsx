"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { ArrowRight, LoaderCircle, MessageSquareText } from "lucide-react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth", { cache: "no-store" }).then((response) => response.json()).then((result: { authenticated?: boolean }) => {
      if (alive && result.authenticated) window.location.replace("/");
    }).catch(() => undefined).finally(() => { if (alive) setChecking(false); });
    return () => { alive = false; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !password) return;
    setSubmitting(true); setError("");
    try {
      const response = await fetch("/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) { setError(result.error ?? "Could not sign in."); setSubmitting(false); inputRef.current?.focus(); return; }
      window.location.replace("/");
    } catch {
      setError("Could not reach the local server. Try again."); setSubmitting(false);
    }
  }

  return <main className="login-page">
    <section className="login-card" aria-labelledby="login-title">
      <div className="login-mark"><MessageSquareText size={22} strokeWidth={2.2} /></div>
      <p className="login-eyebrow">WILDCHAT</p>
      <h1 id="login-title">Prescreen</h1>
      <p className="login-copy">Enter the password to continue.</p>
      <form onSubmit={submit}>
        <label htmlFor="prescreen-password">Password</label>
        <input ref={inputRef} autoFocus id="prescreen-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={checking || submitting} />
        {error && <p className="login-error" role="alert">{error}</p>}
        <button type="submit" disabled={checking || submitting || !password}>{checking || submitting ? <LoaderCircle size={16} className="spin" /> : <>Continue <ArrowRight size={16} /></>}</button>
      </form>
    </section>
  </main>;
}
