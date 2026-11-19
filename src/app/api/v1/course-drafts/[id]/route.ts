import { route, ok } from "@/lib/api/handler";
import { deleteDraft, getDraft } from "@/lib/services/drafts";

export const GET = route(async ({ user, params }) => ok({ draft: await getDraft(user.id, params.id) }));
export const DELETE = route(async ({ user, params }) => {
  await deleteDraft(user.id, params.id);
  return ok({ deleted: true });
});
