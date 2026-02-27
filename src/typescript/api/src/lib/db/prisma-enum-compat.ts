import type {
  CheckStatus as PrismaCheckStatus,
  ContentProvenance as PrismaContentProvenance,
  InvestigationModel as PrismaInvestigationModel,
  InvestigationProvider as PrismaInvestigationProvider,
  Platform as PrismaPlatform,
} from "$lib/generated/prisma/client";
import type {
  CheckStatus as SharedCheckStatus,
  ContentProvenance as SharedContentProvenance,
  InvestigationModel as SharedInvestigationModel,
  InvestigationProvider as SharedInvestigationProvider,
  Platform as SharedPlatform,
} from "@openerrata/shared";

type IsExactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const platformTypesMatch: IsExactly<SharedPlatform, PrismaPlatform> = true;
const statusTypesMatch: IsExactly<SharedCheckStatus, PrismaCheckStatus> = true;
const provenanceTypesMatch: IsExactly<SharedContentProvenance, PrismaContentProvenance> = true;
const providerTypesMatch: IsExactly<SharedInvestigationProvider, PrismaInvestigationProvider> =
  true;
const modelTypesMatch: IsExactly<SharedInvestigationModel, PrismaInvestigationModel> = true;

void platformTypesMatch;
void statusTypesMatch;
void provenanceTypesMatch;
void providerTypesMatch;
void modelTypesMatch;
