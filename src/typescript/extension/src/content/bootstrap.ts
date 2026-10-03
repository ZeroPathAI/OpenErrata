export interface OpenErrataControllerLifecycle {
  boot(): void;
}

export interface OpenErrataBootstrapTarget<TController extends OpenErrataControllerLifecycle> {
  __openerrata_controller?: TController;
}

/**
 * Boot one controller per page. Injection is idempotent: every copy of the
 * content script injected by this extension instance shares the isolated
 * world's `window`, so a later copy finds the live controller and leaves it
 * in place — never a second controller (and listener) for the same page.
 */
export function bootOpenErrataControllerOnce<TController extends OpenErrataControllerLifecycle>(
  target: OpenErrataBootstrapTarget<TController>,
  createController: () => TController,
): TController {
  const existing = target.__openerrata_controller;
  if (existing !== undefined) {
    return existing;
  }
  const controller = createController();
  target.__openerrata_controller = controller;
  controller.boot();
  return controller;
}
