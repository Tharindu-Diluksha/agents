import { analyst } from "./analyst.js";
import { developer } from "./developer.js";
import { e2eTester } from "./e2eTester.js";
import { integrationTester } from "./integrationTester.js";
import { prCreator } from "./prCreator.js";
import { reviewer } from "./reviewer.js";
import { unitTester } from "./unitTester.js";
import type { RoleId } from "../orchestrator/types.js";
import type { RoleSpec } from "./types.js";

export const roles: Record<RoleId, RoleSpec> = {
  analyst,
  developer,
  unitTester,
  integrationTester,
  reviewer,
  e2eTester,
  prCreator,
};
