import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findRecipeElement } from "../tools/fmc_room.js";

test("T3 + R6: a ticket's element is traced to the room node and recipe key that made it", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-link-"));
  const rooms = path.join(project, "01_WIP", "_Tree", "rooms");
  fs.mkdirSync(rooms, { recursive: true });
  fs.writeFileSync(path.join(rooms, "ICU.Bay-02.Room.json"), JSON.stringify({ node: "ICU.Bay-02.Room", room: "ICU bay", built_at: "", made: ["u-bed"],
    elements: [{ key: "wall:north", unique_id: "u-wall" }, { key: "item:Bed", unique_id: "u-bed" }] }));
  fs.writeFileSync(path.join(rooms, "broken.json"), "{ not json");
  assert.deepEqual(findRecipeElement(project, "u-bed"), { node: "ICU.Bay-02.Room", key: "item:Bed" });
  assert.equal(findRecipeElement(project, "u-other"), null, "a hand-made element belongs to no node");
  assert.equal(findRecipeElement("", "u-bed"), null);
  fs.rmSync(project, { recursive: true, force: true });
});
