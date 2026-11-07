"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import BrandMark from "@/components/layout/BrandMark";
import SidebarNav from "@/components/layout/SidebarNav";
import SignOutButton from "@/components/auth/SignOutButton";

// Application shell: fixed sidebar on large screens, slide-in drawer on small screens.
export default function AppShell({ children, user }) {
  const [open, setOpen] = useState(false);

  // Close the drawer with the Escape key while it is open.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-sm focus:bg-panel focus:px-3 focus:py-2 focus:text-sm focus:font-medium"
      >
        Skip to content
      </a>

      {open && (
        <div
          aria-hidden="true"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-30 bg-night/60 lg:hidden"
        />
      )}

      <aside
        id="primary-sidebar"
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col gap-8 overflow-y-auto bg-night px-4 py-5 text-night-text transition-[transform,visibility] duration-200 motion-reduce:transition-none lg:sticky lg:top-0 lg:z-auto lg:h-dvh lg:translate-x-0 lg:visible ${
          open ? "translate-x-0" : "-translate-x-full invisible"
        }`}
      >
        <div className="flex items-center justify-between px-1">
          <Link
            href="/"
            className="rounded-sm text-white outline-offset-4 focus-visible:outline-white"
          >
            <BrandMark />
          </Link>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
            className="grid size-9 place-items-center rounded-sm text-night-text hover:bg-white/10 focus-visible:outline-white lg:hidden"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <SidebarNav onNavigate={() => setOpen(false)} />
      </aside>

      <div className="flex min-h-dvh min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-panel px-4 lg:px-8">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
            aria-expanded={open}
            aria-controls="primary-sidebar"
            className="grid size-9 place-items-center rounded-sm text-ink hover:bg-paper lg:hidden"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          <Link href="/" className="rounded-sm text-ink lg:hidden">
            <BrandMark />
          </Link>
          <p className="ml-auto text-sm text-ink-soft">Development build</p>
          {user && (
            <div className="flex items-center gap-3">
              <p className="text-sm">
                <span className="font-medium">{user.fullName || user.username}</span>
                <span className="ml-2 text-ink-soft">
                  {user.role === "admin" ? "Administrator" : "Investigator"}
                </span>
              </p>
              <SignOutButton />
            </div>
          )}
        </header>

        <main id="main" className="flex-1 px-4 py-8 lg:px-8 lg:py-10">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
