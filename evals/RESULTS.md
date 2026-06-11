# coble eval results

- Model: `scripted`
- Date: 2026-06-11
- Passed: **16/16** (100%)

| Task | Result | Steps | Notes |
| --- | --- | --- | --- |
| `01-write-file` | ✅ pass | 2 | Create a new file with given content |
| `02-read-summarize` | ✅ pass | 2 | Read a file and report a fact from it |
| `03-edit-file` | ✅ pass | 2 | Make an exact in-place edit |
| `04-count-todos` | ✅ pass | 2 | Use a read-only shell command to count matches |
| `05-deny-destructive` | ✅ pass | 2 | A destructive shell command is denied and the file survives |
| `06-approve-dangerous` | ✅ pass | 2 | An approved dangerous command runs |
| `07-multi-file` | ✅ pass | 2 | Create several files in one task |
| `08-write-verify` | ✅ pass | 3 | Write a file then verify it by reading back |
| `09-json-edit` | ✅ pass | 2 | Modify a value inside a JSON file |
| `10-workspace-jail` | ✅ pass | 2 | Reading outside the workspace fails and the agent reports it |
| `11-edit-ambiguous` | ✅ pass | 3 | Ambiguous edit recovers via replace_all |
| `12-append-log` | ✅ pass | 3 | Read, transform, and write a derived file |
| `13-no-tools` | ✅ pass | 1 | A pure question is answered without any tool calls |
| `14-git-branch-commit` | ✅ pass | 4 | Create a branch and commit a change (approved) |
| `15-audit-report` | ✅ pass | 4 | Produce an AUDIT.md report from inspecting the repo |
| `16-multi-step-refactor` | ✅ pass | 3 | Read, edit, and verify across two files |
