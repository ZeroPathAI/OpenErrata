export type UpgradeRequiredState =
  | { active: false }
  | { active: true; message: string; apiBaseUrl: string };

export function shouldIgnoreMetadataLessUpgradeRequiredRefresh(input: {
  state: UpgradeRequiredState;
  apiBaseUrl: string;
  minimumSupportedExtensionVersion: string | undefined;
}): boolean {
  return (
    input.state.active &&
    input.state.apiBaseUrl === input.apiBaseUrl &&
    input.minimumSupportedExtensionVersion === undefined
  );
}
