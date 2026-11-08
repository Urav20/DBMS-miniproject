import ConnectionStatus from "@/components/dashboard/ConnectionStatus";
import EmptyPanel from "@/components/dashboard/EmptyPanel";
import LeadNotice from "@/components/dashboard/LeadNotice";
import { requireSession } from "@/lib/auth/server";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  // Layouts are not re-run on every navigation, so each page checks the session too.
  await requireSession();
  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Dashboard
        </h1>
        <p className="mt-2 max-w-prose text-ink-soft">
          This page shows no investigation data yet. The panels below are
          placeholders for the parts still to be built.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <EmptyPanel title="Your cases">
          Cases assigned to you will be listed here once the database is
          connected.
        </EmptyPanel>
        <EmptyPanel title="Recent custody activity">
          Evidence handovers will appear here, newest first, once the database
          is connected.
        </EmptyPanel>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <ConnectionStatus />
        </div>
        <div className="lg:col-span-2">
          <LeadNotice />
        </div>
      </div>
    </div>
  );
}
