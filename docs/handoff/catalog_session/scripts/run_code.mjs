// Runs a C# body through the Formcraft code bridge: node run_code.mjs <file.cs> [param ...]
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const server = "D:/Fomcraft/FMC_BIM_27/FMC_PLUGINS/FMC_REVIT_TOOLS/formcraft-revit-tools/server/build/";
const { runSendCode } = await import(pathToFileURL(server + "tools/send_code_to_revit.js").href);
const [file, ...params] = process.argv.slice(2);
const r = await runSendCode({ code: fs.readFileSync(file, "utf8"), parameters: params, transactionMode: "none",
  usings: ["System.IO", "System.Collections.Generic", "System.Linq"], purpose: "catalogue card render" });
console.log(r.content?.[0]?.text ?? JSON.stringify(r));
process.exit(0);
