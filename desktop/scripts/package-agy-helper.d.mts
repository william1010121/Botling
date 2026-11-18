export interface PackageAgyHelperOptions {
  platform?: string; arch?: string;
  compile?: (root: string, file: string) => unknown;
  verify?: (file: string) => unknown;
}
export function packageAgyHelper(root: string, options?: PackageAgyHelperOptions): void;
