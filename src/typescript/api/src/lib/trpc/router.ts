import { router } from "./init.js";
import { postRouter } from "./routes/post.js";
import { publicRouter } from "./routes/public.js";
import type {
  EXTENSION_TRPC_PATH,
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

const recordViewAndGetStatusInputMatches: IsExactly<
  RouterInputs["post"]["recordViewAndGetStatus"],
  ExtensionApiProcedureContract[typeof EXTENSION_TRPC_PATH.RECORD_VIEW_AND_GET_STATUS]["input"]
> = true;

const getInvestigationInputMatches: IsExactly<
  RouterInputs["post"]["getInvestigation"],
  ExtensionApiProcedureContract[typeof EXTENSION_TRPC_PATH.GET_INVESTIGATION]["input"]
> = true;

const investigateNowInputMatches: IsExactly<
  RouterInputs["post"]["investigateNow"],
  ExtensionApiProcedureContract[typeof EXTENSION_TRPC_PATH.INVESTIGATE_NOW]["input"]
> = true;

const validateSettingsInputMatches: IsExactly<
  RouterInputs["post"]["validateSettings"],
  ExtensionApiProcedureContract[typeof EXTENSION_TRPC_PATH.VALIDATE_SETTINGS]["input"]
> = true;

const recordViewAndGetStatusOutputMatches: IsExactly<
  RouterOutputs["post"]["recordViewAndGetStatus"],
  ExtensionApiProcedureContract[typeof EXTENSION_TRPC_PATH.RECORD_VIEW_AND_GET_STATUS]["output"]
> = true;

const investigateNowOutputMatches: IsExactly<
  RouterOutputs["post"]["investigateNow"],
  ExtensionApiProcedureContract[typeof EXTENSION_TRPC_PATH.INVESTIGATE_NOW]["output"]
> = true;

const validateSettingsOutputMatches: IsExactly<
  RouterOutputs["post"]["validateSettings"],
  ExtensionApiProcedureContract[typeof EXTENSION_TRPC_PATH.VALIDATE_SETTINGS]["output"]
> = true;

void recordViewAndGetStatusInputMatches;
void getInvestigationInputMatches;
void investigateNowInputMatches;
void validateSettingsInputMatches;
void recordViewAndGetStatusOutputMatches;
void investigateNowOutputMatches;
void validateSettingsOutputMatches;
