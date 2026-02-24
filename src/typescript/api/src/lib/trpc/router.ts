import { router } from "./init.js";
import { postRouter } from "./routes/post.js";
import { publicRouter } from "./routes/public.js";
import type {
  ExtensionApiProcedureContract,
} from "@openerrata/shared";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

export const appRouter = router({
  post: postRouter,
  public: publicRouter,
});

type IsExactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
type RouterInputs = inferRouterInputs<typeof appRouter>;
type RouterOutputs = inferRouterOutputs<typeof appRouter>;

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

const viewPostOutputMatches: IsExactly<
  RouterOutputs["post"]["viewPost"],
  ExtensionApiProcedureContract["post.viewPost"]["output"]
> = true;

const getInvestigationOutputMatches: IsExactly<
  RouterOutputs["post"]["getInvestigation"],
  ExtensionApiProcedureContract["post.getInvestigation"]["output"]
> = true;

const investigateNowOutputMatches: IsExactly<
  RouterOutputs["post"]["investigateNow"],
  ExtensionApiProcedureContract["post.investigateNow"]["output"]
> = true;

const validateSettingsOutputMatches: IsExactly<
  RouterOutputs["post"]["validateSettings"],
  ExtensionApiProcedureContract["post.validateSettings"]["output"]
> = true;

void viewPostInputMatches;
void getInvestigationInputMatches;
void investigateNowInputMatches;
void validateSettingsInputMatches;
void viewPostOutputMatches;
void getInvestigationOutputMatches;
void investigateNowOutputMatches;
void validateSettingsOutputMatches;
