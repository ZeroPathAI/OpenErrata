export interface OpenErrataControllerLifecycle {
  boot(): void;
  dispose(): void;
}

export type OpenErrataBootstrapTarget<TController extends OpenErrataControllerLifecycle> = {
  __openerrata_loaded?: boolean;
  __openerrata_controller?: TController;
};

export function bootOpenErrataController<
  TController extends OpenErrataControllerLifecycle,
>(
  target: OpenErrataBootstrapTarget<TController>,
  createController: () => TController,
): TController {
  if (target.__openerrata_controller) {
    try {
      target.__openerrata_controller.dispose();
    } catch (error: unknown) {
      console.debug(
        "Failed to dispose previous OpenErrata controller before boot",
        error,
      );
    }
  }

  const controller = createController();
  target.__openerrata_controller = controller;
  target.__openerrata_loaded = true;
  controller.boot();
  return controller;
}
