import AppShell from "@/components/layout/AppShell";
import { requireSession } from "@/lib/auth/server";

// Every page inside this route group is rendered inside the application shell,
// and only for a signed-in user.
export default async function WorkspaceLayout({ children }) {
  const session = await requireSession();
  return (
    <AppShell user={{ fullName: session.fullName, username: session.username, role: session.role }}>
      {children}
    </AppShell>
  );
}
