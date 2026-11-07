import { redirect } from "next/navigation";
import Link from "next/link";
import BrandMark from "@/components/layout/BrandMark";
import LoginForm from "@/components/auth/LoginForm";
import { getCurrentSession } from "@/lib/auth/server";
import { safeRedirectPath } from "@/lib/auth/validation";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }) {
  const params = await searchParams;
  const next = safeRedirectPath(Array.isArray(params?.next) ? params.next[0] : params?.next);

  // Already signed in: go straight on.
  if (await getCurrentSession()) redirect(next);

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 inline-block rounded-sm text-ink">
          <BrandMark />
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-2 text-sm text-ink-soft">
          Use the account your administrator created for you.
        </p>
        <section className="mt-6 rounded-sm border border-line bg-panel p-6">
          <LoginForm next={next} />
        </section>
      </div>
    </main>
  );
}
