import type {
  CheckStatus as PrismaCheckStatus,
  ContentProvenance as PrismaContentProvenance,
  InvestigationModel as PrismaInvestigationModel,
  InvestigationProvider as PrismaInvestigationProvider,
  MarkdownSource as PrismaMarkdownSource,
  Platform as PrismaPlatform,
} from "$lib/generated/prisma/client";
import type {
  CheckStatus as SharedCheckStatus,
  ContentProvenance as SharedContentProvenance,
  InvestigationModel as SharedInvestigationModel,
  InvestigationProvider as SharedInvestigationProvider,
  MarkdownSource as SharedMarkdownSource,
  Platform as SharedPlatform,
} from "@openerrata/shared";

type IsExactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const platformTypesMatch: IsExactly<SharedPlatform, PrismaPlatform> = true;
const statusTypesMatch: IsExactly<SharedCheckStatus, PrismaCheckStatus> = true;
const providerTypesMatch: IsExactly<SharedInvestigationProvider, PrismaInvestigationProvider> =
  true;
const modelTypesMatch: IsExactly<SharedInvestigationModel, PrismaInvestigationModel> = true;
const provenanceTypesMatch: IsExactly<SharedContentProvenance, PrismaContentProvenance> = true;
const markdownSourceTypesMatch: IsExactly<SharedMarkdownSource, PrismaMarkdownSource> = true;

void platformTypesMatch;
void statusTypesMatch;
void providerTypesMatch;
void modelTypesMatch;
void provenanceTypesMatch;
void markdownSourceTypesMatch;
