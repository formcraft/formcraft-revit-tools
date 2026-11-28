/**
 * Room use from the room's name, department and occupancy text. The word lists are Formcraft's own assumption, not
 * the regulations; anything that does not match is "unmapped" and reported as REVIEW, never guessed.
 */
export type RoomUse = "wc" | "bathroom" | "kitchen" | "bedroom" | "living" | "habitable" | "circulation" | "service" | "unmapped";

const ORDER: Array<[RoomUse, RegExp]> = [
  ["wc", /\bw\.?\s?c\b|\btoilet|\blavatory|\bwater closet/i],
  ["bathroom", /\bbath|\bshower|en-?suite|\bwashroom/i],
  ["kitchen", /\bkitchen/i],
  ["bedroom", /\bbed\s?room|\bbedrm\b|\bmaster\b|\bguest room|\bsleeping|\bdormitor/i],
  ["living", /\bliving|\blounge|\bsitting|\bfamily room/i],
  ["habitable", /\bdining|\bstudy\b|\boffice|\bden\b|\bplayroom|\blibrary|\bclassroom|\bworkroom/i],
  ["circulation", /\bcorridor|\bpassage|\bhall|\blobby|\blanding|\bstair|\bfoyer|\bentrance|\bveranda|\bbalcony|\bterrace|\bporch|\bcirculation/i],
  ["service", /\bstore|\bstorage|\blaundry|\butility|\bgarage|\bplant\b|\bshaft|\bduct|\bserver|\bcleaner|\bpantry|\bcloset|\bwardrobe|\bdressing|\belectrical|\briser|\bboiler|\btank/i],
];

export function roomUse(name: string, department = "", occupancy = ""): RoomUse {
  for (const text of [name, department, occupancy]) {
    if (!text || !text.trim()) continue;
    for (const [use, re] of ORDER) if (re.test(text)) return use;
  }
  return "unmapped";
}

export function isHabitable(use: RoomUse): boolean {
  return use === "bedroom" || use === "living" || use === "habitable";
}

export const ROOM_USE_NOTE = "Room use is read from the room name, department and occupancy with Formcraft's own word list (fmc/permit/roomuse.ts). It is an assumption, not the regulations.";
