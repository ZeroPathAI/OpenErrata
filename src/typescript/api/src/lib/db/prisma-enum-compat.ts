import type {
  CheckStatus as PrismaCheckStatus,
  InvestigationModel as PrismaInvestigationModel,
  InvestigationProvider as PrismaInvestigationProvider,
  Platform as PrismaPlatform,
} from "$lib/generated/prisma/client";
import type {
  CheckStatus as SharedCheckStatus,
  InvestigationModel as SharedInvestigationModel,
  InvestigationProvider as SharedInvestigationProvider,
  Platform as SharedPlatform,
} from "@openerrata/shared";

type IsExactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const platformTypesMatch: IsExactly<SharedPlatform, PrismaPlatform> = true;
const statusTypesMatch: IsExactly<SharedCheckStatus, PrismaCheckStatus> = true;
const providerTypesMatch: IsExactly<SharedInvestigationProvider, PrismaInvestigationProvider> =
  true;
const modelTypesMatch: IsExactly<SharedInvestigationModel, PrismaInvestigationModel> = true;

void platformTypesMatch;
void statusTypesMatch;
void providerTypesMatch;
void modelTypesMatch;
