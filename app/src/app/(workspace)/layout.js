import AppShell from "@/components/layout/AppShell";

// Every page inside this route group is rendered inside the application shell.
export default function WorkspaceLayout({ children }) {
  return <AppShell>{children}</AppShell>;
}
