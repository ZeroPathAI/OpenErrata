export function requireMountTarget(options: { pageLabel: string; mountId?: string }): HTMLElement {
  const mountId = options.mountId ?? "app";
  const target = document.getElementById(mountId);
  if (!target) {
    throw new Error(`Missing #${mountId} mount point for ${options.pageLabel} page`);
  }
  return target;
}
