"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navigation } from "@/config/site";

export default function SidebarNav({ onNavigate }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary" className="flex flex-col gap-8">
      <ul className="flex flex-col gap-1">
        {navigation.primary.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={`block rounded-sm border-l-2 px-3 py-2 text-sm font-medium outline-offset-0 focus-visible:outline-white ${
                  active
                    ? "border-marker bg-white/10 text-white"
                    : "border-transparent text-night-text hover:bg-white/5 hover:text-white"
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>

      <div>
        <p
          id="planned-modules"
          className="px-3 text-xs font-medium text-night-dim"
        >
          Planned, not built yet
        </p>
        <ul aria-labelledby="planned-modules" className="mt-2 flex flex-col gap-1">
          {navigation.planned.map((label) => (
            <li
              key={label}
              className="rounded-sm border-l-2 border-transparent px-3 py-2 text-sm text-night-dim"
            >
              {label}
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
