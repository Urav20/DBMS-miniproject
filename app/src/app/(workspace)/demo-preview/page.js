import DemoWorkspace from "@/components/demo/DemoWorkspace";
import { requireSession } from "@/lib/auth/server";

export const metadata = { title: "Workspace UI Preview" };

// This page intentionally uses local mock records so Person A can develop
// the presentation layer independently of Person B's API/retrieval work.
export default async function WorkspacePreviewPage() {
  await requireSession();
  return <DemoWorkspace />;
}
