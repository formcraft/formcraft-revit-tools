/** fmc_review helpers (RW-9 default project code, RW-13 BCF cap). Pure. */

/** RW-9: the project code: given, else FMC_Project.json's code, else the folder name's first part (as fmc_report). */
export function defaultProjectCode(given: string, folderName: string, manifestCode?: string): { code: string; source: string } {
  if (given.trim()) return { code: given.trim().toUpperCase(), source: "given" };
  if (manifestCode && manifestCode.trim()) return { code: manifestCode.trim().toUpperCase(), source: "FMC_Project.json" };
  const fromFolder = folderName.split("_")[0].trim().toUpperCase();
  return { code: fromFolder, source: fromFolder ? "folder name" : "none" };
}

/** RW-13 */
export const BCF_MAX_BYTES = 50 * 1024 * 1024;
export function bcfFileProblem(file: string, bytes: number): string | null {
  if (!/\.bcf(zip)?$/i.test(file)) return `${file} is not a .bcfzip or .bcf file`;
  if (bytes > BCF_MAX_BYTES) return `${file} is ${Math.round(bytes / 1048576)} MB, over the ${BCF_MAX_BYTES / 1048576} MB limit`;
  return null;
}
