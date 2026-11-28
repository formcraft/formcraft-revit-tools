import { z } from "zod";

/** fmc_assemblies arguments (F59). */
export const FMC_ASSEMBLIES_SHAPE = {
  action: z.enum(["check", "pat", "read", "plan", "apply", "legend"]),
  spec: z.record(z.string(), z.unknown()).optional()
    .describe("The assembly designs, when the kit's 03_Master_Data\\FMC_Assemblies.json is missing or to try a change: {patterns, curtain_walls, railings, legend}"),
  only: z.array(z.string()).optional().describe("plan, apply: only these design names"),
  project_folder: z.string().optional().default("").describe("pat: the project folder (the .pat files go to 01_WIP\\_Assemblies)"),
  confirm: z.boolean().optional().default(false).describe("pat, apply: needed with dry_run=false, after the person has seen the dry run"),
  dry_run: z.boolean().optional().default(true),
};

export type FmcAssembliesArgs = z.infer<z.ZodObject<typeof FMC_ASSEMBLIES_SHAPE>>;
