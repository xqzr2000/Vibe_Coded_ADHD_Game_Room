// Agent registry — OpenClaw-style extension point.
//
// To add a third agent later:
//   1. Create server/agents/<name>.js exporting an agent card
//      ({ id, name, role, color }) and its behavior functions.
//   2. Import and add the card here so the UI can render it.
//   3. Wire its behavior into the orchestrator in server/index.js.

import { doctorAgent } from "./doctor.js";
import { researcherAgent } from "./researcher.js";

export const agents = [doctorAgent, researcherAgent];

export function getAgent(id) {
  return agents.find((a) => a.id === id);
}
