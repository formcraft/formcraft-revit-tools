/**
 * Drawing register: a sheet-list schedule filtered so PARKED sheets drop out.
 * Fields are sheet number, sheet name, current revision and the status parameter.
 * The status parameter is the browser parameter when the sheet has one, otherwise FMC_Sheet_Status.
 */

export interface ScheduleFact {
  name: string;
  exists: boolean;
  fields: string[];
  filters: Array<{ field: string; type: string; value: string }>;
  status_parameter: string | null;
}

export interface RegisterSheet {
  number: string;
  name: string;
  revision: string;
  status: string;
  parked: boolean;
}

export interface RegisterPlan {
  schedule: string;
  create: boolean;
  status_parameter: string | null;
  add_fields: string[];
  add_filters: Array<{ field: string; type: string; value: string }>;
  excluded: RegisterSheet[];
  shown: RegisterSheet[];
  changes: boolean;
  code?: string;
  reason?: string;
}

const NUMBER_FIELDS = ["sheet number", "number"];
const NAME_FIELDS = ["sheet name", "name"];
const REVISION_FIELDS = ["current revision"];

function hasField(fields: string[], names: string[]): boolean {
  const have = new Set(fields.map((field) => field.trim().toLowerCase()));
  return names.some((name) => have.has(name));
}

/** What the schedule would gain, and which sheets the PARKED filter drops. */
export function planRegister(schedule: ScheduleFact, sheets: RegisterSheet[]): RegisterPlan {
  const status = schedule.status_parameter;
  const add_fields: string[] = [];
  if (!hasField(schedule.fields, NUMBER_FIELDS)) add_fields.push("Sheet Number");
  if (!hasField(schedule.fields, NAME_FIELDS)) add_fields.push("Sheet Name");
  if (!hasField(schedule.fields, REVISION_FIELDS)) add_fields.push("Current Revision");
  if (status && !schedule.fields.some((field) => field.trim().toLowerCase() === status.toLowerCase())) add_fields.push(status);
  const add_filters = status
    ? ["PARKED", "Parked"].filter((value) => !schedule.filters.some((filter) =>
      filter.field.trim().toLowerCase() === status.toLowerCase() && filter.type === "NotEqual" && filter.value === value))
      .map((value) => ({ field: status, type: "NotEqual", value }))
    : [];
  const excluded = sheets.filter((sheet) => sheet.parked);
  const shown = sheets.filter((sheet) => !sheet.parked);
  const code = status ? undefined : "FMC-REGISTER-STATUS";
  const reason = status ? undefined : "No browser parameter and no FMC_Sheet_Status parameter. The PARKED filter cannot be set. Add the parameter in the kit.";
  const changes = !schedule.exists || add_fields.length > 0 || add_filters.length > 0;
  return {
    schedule: schedule.name,
    create: !schedule.exists,
    status_parameter: status,
    add_fields,
    add_filters,
    excluded,
    shown,
    changes: changes || excluded.length > 0,
    ...(code ? { code, reason } : {}),
  };
}

export function sheetParked(status: string | null | undefined, browser: string | null | undefined): boolean {
  const parked = (value: string | null | undefined) => (value ?? "").trim().toUpperCase() === "PARKED";
  return parked(status) || parked(browser);
}
