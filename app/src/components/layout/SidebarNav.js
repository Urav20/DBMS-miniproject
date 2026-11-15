"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navigation } from "@/config/site";

export default function SidebarNav({ onNavigate, role }) {
  const pathname = usePathname();
  const items = [...navigation.primary, ...(role === "admin" ? navigation.admin : [])];

  return (
    <nav aria-label="Primary">
      <ul className="flex flex-col gap-1">
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Link href={item.href} onClick={onNavigate} aria-current={active ? "page" : undefined}
                className={`block rounded-sm border-l-2 px-3 py-2 text-sm font-medium outline-offset-0 focus-visible:outline-white ${active ? "border-marker bg-white/10 text-white" : "border-transparent text-night-text hover:bg-white/5 hover:text-white"}`}>
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
