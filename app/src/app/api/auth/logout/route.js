import { createLogoutHandler } from "@/lib/auth/handlers";

export const dynamic = "force-dynamic";

// POST /api/auth/logout
export const POST = createLogoutHandler();
