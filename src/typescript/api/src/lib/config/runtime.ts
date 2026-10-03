import { getEnv } from "./env.js";

/** Maximum SELECTOR admissions per UTC day (SPEC §2.10). */
export function getSelectorDailyBudget(): number {
  return getEnv().SELECTOR_DAILY_BUDGET;
}

export function getIpRangeCreditCap(): number {
  return getEnv().IP_RANGE_CREDIT_CAP;
}
