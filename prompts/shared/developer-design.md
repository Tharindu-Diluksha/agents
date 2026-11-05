1. **Check the suite is green before touching anything.** Run the repo's unit tests (the Stack section lists the command). If anything is red, stop and report it as blocked, listing the failing tests and the first lines of each failure. Don't fix them: that is a separate problem the user needs to know about.
2. **Design.** Read the feature doc. Find the smallest architecture that satisfies it, and reuse existing code before adding abstractions.
3. **ADR** (template `adr.md`, under 300 words): one decision, the forces behind it, the rejected alternatives, the consequences.
4. **Implementation plan** (template `impl-plan.md`), listing:
   - every file to touch (`path:line` for existing files) and the order of changes;
   - the **test plan**: the unit tests per AC-id that the Unit Tester will write first, the integration points for the Integration Tester, and the user-facing flows for E2E;
   - a verification step the user can run.
5. Don't implement anything in this phase.
