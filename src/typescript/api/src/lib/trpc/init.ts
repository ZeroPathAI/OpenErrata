import { initTRPC } from "@trpc/server";
import {
  extensionRuntimeErrorCodeSchema,
  type ExtensionRuntimeErrorCode,
} from "@openerrata/shared";
import type { Context } from "./context.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toRuntimeErrorCode(value: unknown): ExtensionRuntimeErrorCode | undefined {
  if (!isRecord(value)) return undefined;
  const parsed = extensionRuntimeErrorCodeSchema.safeParse(value["openerrataCode"]);
  return parsed.success ? parsed.data : undefined;
}

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    const openerrataCode = toRuntimeErrorCode(error.cause);
    return {
      ...shape,
      data: {
        ...shape.data,
        ...(openerrataCode === undefined ? {} : { openerrataCode }),
      },
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
