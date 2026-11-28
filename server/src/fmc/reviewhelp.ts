/**
 * RW-7: fmc_review has 21 actions on one schema. action "help" names the fields one action reads, so a bot does not
 * guess (text is an answer, a solution or a reason depending on the action). Pure.
 */
export interface ActionHelp { does: string; needs: string[]; optional: string[]; writes: string }

const P = "project_folder";
export const REVIEW_ACTION_HELP: Record<string, ActionHelp> = {
  list: { does: "Items in the register, one line each (full for whole items).", needs: [P], optional: ["filter", "my_disciplines", "full", "project_code"], writes: "nothing" },
  item: { does: "One item in full.", needs: [P, "id"], optional: [], writes: "nothing" },
  raise: { does: "A new review item; links the elements selected in Revit when link_selection is true.", needs: [P, "title", "description", "lead", "owner"], optional: ["disciplines", "priority", "due", "link_selection", "project_code", "by"], writes: "the register" },
  answer: { does: "A discipline's answer. text is the answer.", needs: [P, "id", "text"], optional: ["discipline", "done", "by"], writes: "the register" },
  solve: { does: "The owner marks it done. text is the solution.", needs: [P, "id", "text"], optional: ["by"], writes: "the register" },
  check: { does: "The raiser accepts and closes (accept true) or reopens; text is the reason to reopen.", needs: [P, "id"], optional: ["accept", "text", "by"], writes: "the register" },
  cloud: { does: "A revision cloud around the item's linked elements. Changes the model: dry run first.", needs: [P, "id"], optional: ["dry_run"], writes: "the model (dry_run false only)" },
  print: { does: "A sheet's PDF and its item list into 01_WIP\\_Reviews\\Prints.", needs: [P, "sheet"], optional: ["kind", "by"], writes: "the print folder and the register" },
  prints: { does: "A sheet's print history.", needs: [P], optional: ["sheet"], writes: "nothing" },
  mark: { does: "A Mark & Review ticket. description (or text) is the note.", needs: [P, "to"], optional: ["assignee", "title", "description", "text", "where", "audio", "transcript", "picture", "priority", "by"], writes: "the register" },
  comment: { does: "A reply in a ticket's thread. text is the reply.", needs: [P, "id"], optional: ["text", "audio", "transcript", "by"], writes: "the register" },
  take: { does: "Start a ticket; a ticket for anyone gets its owner.", needs: [P, "id"], optional: ["by"], writes: "the register" },
  queue: { does: "What waits for the AI, a person or a discipline, most urgent first.", needs: [P], optional: ["to", "assignee"], writes: "nothing" },
  bcf_export: { does: "BCF 2.1 of the open tickets (or ids). Dry run first.", needs: [P], optional: ["ids", "dry_run"], writes: "01_WIP\\_Reviews\\BCF (dry_run false only)" },
  bcf_import: { does: "Tickets from a .bcfzip (at most 50 MB). Dry run first; every new ticket records the file it came from.", needs: [P, "file"], optional: ["dry_run", "by"], writes: "the register (dry_run false only)" },
  plan_fix: { does: "The structured fix from the ticket's notes, as a dry run. Never applies.", needs: [P, "id"], optional: ["facts"], writes: "nothing" },
  apply_fix: { does: "Plans again from the model; with dry_run false, approved_by and plan_hash applies the steps in one transaction.", needs: [P, "id"], optional: ["dry_run", "approved_by", "plan_hash", "tree", "by"], writes: "the model (dry_run false only)" },
  show: { does: "Open your own review view on the ticket's camera and box (view false: select and zoom).", needs: [P, "id"], optional: ["view"], writes: "a review view (UI only)" },
  clashes: { does: "Clash results of a Navisworks test as tickets.", needs: [P, "test"], optional: ["dry_run", "by"], writes: "the register (dry_run false only)" },
  transcribe: { does: "A voice note offline (id and note), or any audio file.", needs: [], optional: [P, "id", "note", "audio", "model", "language"], writes: "the register when id is given" },
  whisper_setup: { does: "What is installed for offline voice notes; downloads only with dry_run false.", needs: [], optional: ["model", "dry_run"], writes: "%LOCALAPPDATA%\\Formcraft\\whisper (dry_run false only)" },
};

export function reviewHelp(action: string): object {
  const a = action.trim();
  if (!a) return { actions: Object.fromEntries(Object.entries(REVIEW_ACTION_HELP).map(([k, v]) => [k, v.does])), next: "Pass help_for with one action for its fields" };
  const h = REVIEW_ACTION_HELP[a];
  if (!h) return { error: `No action ${a}. Actions: ${Object.keys(REVIEW_ACTION_HELP).join(", ")}` };
  return { action: a, ...h };
}

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
