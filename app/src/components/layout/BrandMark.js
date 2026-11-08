import { site } from "@/config/site";

// Logo tile plus wordmark. The wordmark inherits the surrounding text colour.
export default function BrandMark({ className = "" }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <svg viewBox="0 0 32 32" aria-hidden="true" className="size-8 shrink-0">
        <rect width="32" height="32" rx="4" fill="#0b6b75" />
        <path
          d="M9 9l14 14M23 9L9 23"
          stroke="#fff"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <circle cx="16" cy="16" r="3.2" fill="#e8b100" />
      </svg>
      <span className="text-lg font-semibold tracking-tight">{site.name}</span>
    </span>
  );
}
