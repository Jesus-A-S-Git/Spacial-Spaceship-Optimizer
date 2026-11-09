"use strict";
// Shared by the optimizer page (app.js) and the Top 100 page (analyze.js).
// Room categories. kind = how the optimizer treats the room:
//   priority  = gets the most armor (PRIORITY_WEIGHT) and its own sweet spot
//   combat    = armored, walkable, counted for crew travel
//   noncombat = kept away from armor and lifts
//   resource  = goes on r tiles in the hull (or x tiles if allowed), scored like non-combat
// Sizes are only starting suggestions for the "+ Add" buttons; edit them to match your rooms.
const ROOM_CATEGORIES = [
  { id: "reactor", label: "Reactor", kind: "priority", color: "#d94b4b", size: [3, 2] },
  { id: "shield", label: "Shield generator", kind: "priority", color: "#e07a9c", size: [3, 2] },
  { id: "priority", label: "Other priority", kind: "priority", color: "#b03a5b", size: [3, 2] },
  { id: "laser", label: "Laser", kind: "combat", color: "#3d6fd1", size: [2, 2] },
  { id: "antiair", label: "Anti-air", kind: "combat", color: "#8466d8", size: [2, 2] },
  { id: "missile", label: "Missile", kind: "combat", color: "#d98a3d", size: [3, 2] },
  { id: "hangar", label: "Hangar", kind: "combat", color: "#3f8f9f", size: [4, 2] },
  { id: "antimissile", label: "Anti-missile (engines)", kind: "combat", color: "#a3b84a", size: [3, 2] },
  { id: "antitele", label: "Anti-teleport", kind: "combat", color: "#b86b4a", size: [1, 2] },
  { id: "boarding", label: "Boarding (teleport)", kind: "combat", color: "#c45ab0", size: [3, 2] },
  { id: "crewsupport", label: "Crew support", kind: "combat", color: "#6bb08a", size: [2, 2] },
  { id: "cloak", label: "Cloak & radar", kind: "combat", color: "#6c6f8a", size: [3, 2] },
  { id: "shieldsupport", label: "Shield support", kind: "combat", color: "#e0a3b8", size: [2, 2] },
  { id: "command", label: "Command", kind: "combat", color: "#7f9fb8", size: [3, 2] },
  { id: "booster", label: "Booster", kind: "combat", color: "#d6a35c", size: [2, 3] },
  { id: "utility", label: "Other utility", kind: "combat", color: "#8a90a6", size: [2, 2] },
  { id: "combat", label: "Other combat", kind: "combat", color: "#5b7fbf", size: [2, 2] },
  { id: "crew", label: "Bedroom", kind: "noncombat", color: "#9b4f7f", size: [3, 2] },
  { id: "noncombat", label: "Other non-combat", kind: "noncombat", color: "#b5934a", size: [2, 2] },
  { id: "resource", label: "Resource", kind: "resource", color: "#3b6fa0", size: [2, 2] },
];
const KIND_LABELS = { priority: "Priority (most armor)", combat: "Combat", noncombat: "Non-combat", resource: "Resource space" };
const CAT = Object.fromEntries(ROOM_CATEGORIES.map((c) => [c.id, c]));
const catOf = (id) => CAT[id] || CAT.combat;

