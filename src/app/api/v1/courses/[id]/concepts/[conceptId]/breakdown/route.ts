import { route, ok } from "@/lib/api/handler";
import { addPrerequisiteScaffold } from "@/lib/services/courses";

export const POST = route(async ({ user, params }) => ok(await addPrerequisiteScaffold(user.id, params.id, params.conceptId), { status: 201 }));
