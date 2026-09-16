# Contributing

This is development preview source. OrgManage-authored material uses [MIT](LICENSE); review the [license scope](LICENSE_DECISION.md) before contributing third-party material, which retains its own rights and notices. Do not submit secrets, private conversation, personal paths, account identifiers, real ledgers, logs or private design evidence.

## Change process

1. Describe the problem, expected behavior and affected acceptance criteria. Keep each PR bounded enough for a useful review.
2. Record the base commit and exact file hashes before editing. Coordinate ownership when several contributors share a working directory; untracked files are not inherited by a worktree automatically.
3. Inspect script, workflow and lock changes. On a clean Windows environment with Node 24.14.1, run the installation and `verify:public` commands in README.md. Use only synthetic inputs.
4. Request one CodeRabbit review manually after deterministic checks pass and the repository owner has enabled the service. It is optional while service access is unavailable. A review request sends public code/context to that service; follow the published repository policy.
5. For each actionable finding, record the location, reproduction or other evidence, severity, accepted/rejected/deferred decision, reason and validation. Duplicate or incorrect findings may be rejected with evidence. An AI suggestion does not authorize its own patch.
6. Before merge, compare the reviewed base and current target, inspect the final diff, rerun checks affected by any new changes, and record results for the final commit. Human review is required for authority, budget, disclosure, stop, unknown, adoption/deployment, workflow and rights changes.

No workflow automatically merges, deploys, publishes, changes repository permissions or purchases review capacity. Do not bypass a failing protection rule to satisfy an AI reviewer.

## One source baseline

Before first publication, internal working source is authoritative and a public candidate is a generated, immutable projection with an explicit source-to-destination manifest and SHA-256 hashes. Edit the source of each mapped file and regenerate; never maintain an independent editable export.

At first publication the owner designates the public repository default branch as the source baseline for the approved file set. Subsequent source work uses branches/PRs against that baseline. Internal private requirements and evidence remain separately stored and cannot be copied into the public tree or history. If the internal workspace needs an imported PR, verify the public commit and manifest hashes against its recorded base, review a three-way diff, resolve concurrent edits, and run the registered local regression profile. A synchronization conflict stops that import; it does not justify overwriting newer work.

The release candidate binds exact source bytes, destination paths, tool versions and verification receipts. Any changed input invalidates its prior inspection result. Publication and product release remain separate owner decisions.
