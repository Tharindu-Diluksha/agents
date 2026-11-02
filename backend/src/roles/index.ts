import { analyst } from "./analyst.js";
import { developer } from "./developer.js";
import { prCreator } from "./prCreator.js";
import { reviewer } from "./reviewer.js";
import { tester } from "./tester.js";
import type { RoleId } from "../orchestrator/types.js";
import type { RoleSpec } from "./types.js";

export const roles: Record<RoleId, RoleSpec> = {
  analyst,
  developer,
  reviewer,
  tester,
  prCreator,
};
