import { createLoginHandler } from "@/lib/auth/handlers";
import { authenticate } from "@/lib/auth/service";
import { findLoginUser } from "@/lib/auth/users";

export const dynamic = "force-dynamic";

// POST /api/auth/login   body: { username, password, next? }
export const POST = createLoginHandler({
  authenticateUser: (input) => authenticate(input, { findUser: findLoginUser }),
});
