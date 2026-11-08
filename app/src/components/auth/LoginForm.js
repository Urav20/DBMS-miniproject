"use client";

import { useState } from "react";

// Sends the credentials to POST /api/auth/login. The server decides everything:
// whether the sign-in is valid, the session cookie, and where to go next.
export default function LoginForm({ next }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: form.get("username"),
          password: form.get("password"),
          next,
        }),
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data?.redirectTo) {
        // A full page load, so the next page is rendered with the new cookie.
        window.location.assign(data.redirectTo);
        return;
      }
      setError(data?.error?.message ?? "Sign-in failed. Please try again.");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    }
    setBusy(false);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="username" className="text-sm font-medium">
          Username
        </label>
        <input
          id="username"
          name="username"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          maxLength={50}
          className="rounded-sm border border-line-strong bg-panel px-3 py-2 text-base"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="rounded-sm border border-line-strong bg-panel px-3 py-2 text-base"
        />
      </div>

      {error && (
        <p role="alert" className="border-l-4 border-marker bg-marker-wash px-3 py-2 text-sm text-marker-ink">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="rounded-sm bg-accent px-5 py-2.5 font-medium text-white hover:bg-accent-deep disabled:opacity-60"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
