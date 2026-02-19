import { getEnv } from "./env.js";

export function getSelectorBudget(): number {
  return getEnv().SELECTOR_BUDGET;
}

export function getIpRangeCreditCap(): number {
  return getEnv().IP_RANGE_CREDIT_CAP;
}
