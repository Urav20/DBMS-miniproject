"use client";

import { useState } from "react";

export default function SignOutButton() {
  const [busy, setBusy] = useState(false);

  async function signOut() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      // Full page load: clears the client-side page cache as well.
      window.location.assign("/login");
    }
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      className="rounded-sm border border-line-strong px-3 py-1.5 text-sm font-medium text-ink hover:bg-paper disabled:opacity-60"
    >
      Sign out
    </button>
  );
}
