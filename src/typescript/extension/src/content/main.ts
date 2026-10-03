import { PageSessionController } from "./page-session-controller";
import { bootOpenErrataControllerOnce } from "./bootstrap";

declare global {
  interface Window {
    __openerrata_controller?: PageSessionController;
  }
}

bootOpenErrataControllerOnce(window, () => new PageSessionController());
