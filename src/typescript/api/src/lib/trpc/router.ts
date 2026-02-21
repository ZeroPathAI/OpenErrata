import { router } from "./init.js";
import { postRouter } from "./routes/post.js";
import { publicRouter } from "./routes/public.js";
import type {
  ExtensionApiProcedureContract,
} from "@openerrata/shared";
import type { inferRouterInputs } from "@trpc/server";

export const appRouter = router({
  post: postRouter,
  public: publicRouter,
});

type IsExactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
type RouterInputs = inferRouterInputs<typeof appRouter>;

const viewPostInputMatches: IsExactly<
  RouterInputs["post"]["viewPost"],
  ExtensionApiProcedureContract["post.viewPost"]["input"]
> = true;

const getInvestigationInputMatches: IsExactly<
  RouterInputs["post"]["getInvestigation"],
  ExtensionApiProcedureContract["post.getInvestigation"]["input"]
> = true;

const investigateNowInputMatches: IsExactly<
  RouterInputs["post"]["investigateNow"],
  ExtensionApiProcedureContract["post.investigateNow"]["input"]
> = true;

const validateSettingsInputMatches: IsExactly<
  RouterInputs["post"]["validateSettings"],
  ExtensionApiProcedureContract["post.validateSettings"]["input"]
> = true;

void viewPostInputMatches;
void getInvestigationInputMatches;
void investigateNowInputMatches;
void validateSettingsInputMatches;
