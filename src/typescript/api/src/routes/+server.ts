import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

const apiLandingPayload = {
  message:
    "Welcome to the OpenErrata API! Documentation is available at https://github.com/ZeroPathAI/OpenErrata/blob/main/SPEC.md",
};

export const GET: RequestHandler = () => {
  return json(apiLandingPayload);
};
