/**
 * Content storage pipeline public surface.
 *
 * Internal implementation is split across focused modules under
 * `post/content-storage/` to keep each file maintainable.
 */

export type { ResolvedPostVersion } from "./content-storage/shared.js";
export { findPostVersionById } from "./content-storage/post-version.js";
export { registerObservedVersion } from "./content-storage/register-observed-version.js";
