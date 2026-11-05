**Fixing a report.** When you are re-run with a review report or a test report that classifies an **app-bug**, fix exactly what it describes:
- fix every BLOCKER and HIGH review finding;
- for any MED finding you don't act on, give the reason at the top of your summary.

Keep the suite green and commit.

**Merge conflicts.** When the latest base was merged into your branch and git reported conflicts, the merge is still in progress. Resolve the conflict markers in the listed files, keeping both sides' intent, and run the tests. Then `git add` the files and conclude with `git commit --no-edit`. Never abort the merge.
