import { route, ok } from "@/lib/api/handler";
import { FlagGradingBody } from "@/lib/schemas/api";
import { flagGrading } from "@/lib/services/sessions";

export const POST = route(async ({ user, params, body }) => ok({ session: await flagGrading(user.id, params.id, body.note) }), { body: FlagGradingBody });
