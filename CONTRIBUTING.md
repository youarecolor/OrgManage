# Contributing

This is development preview source. OrgManage-authored material uses [MIT](LICENSE); review the [license scope](LICENSE_DECISION.md) before contributing third-party material, which retains its own rights and notices. Do not submit secrets, private conversation, personal paths, account identifiers, real ledgers, logs or private design evidence.

## Change process

1. Describe the problem, expected behavior and affected acceptance criteria. Keep each PR bounded enough for a useful review.
2. Branch from public `main` and record the full base and proposed head commit IDs. Coordinate ownership when several contributors share a working directory; untracked files are not inherited by a worktree automatically. Contributors can use the public commits, changed-file list and CI links; private release manifests are not required.
3. Inspect script, workflow and lock changes before execution or service activation. Use the Windows / Node 24.14.1 installation and `verify:public` commands in [README](README.md) with synthetic inputs. Untrusted public PR code runs only on standard GitHub-hosted runners, without development PCs, existing VMs, credentials or real ledgers.
4. Follow the manual review procedure below after deterministic checks pass. If review is not authorized or available, record it as not run with the reason; do not substitute another external service or buy capacity.
5. For each actionable finding, record the location, reproduction or other evidence, severity, accepted/rejected/deferred decision, reason and validation. Duplicate or incorrect findings may be rejected with evidence. An AI suggestion does not authorize its own patch.
6. Before merge, compare the reviewed base and current target, inspect the final diff, rerun checks affected by any new changes, and record results for the final commit. Human review is required for authority, budget, disclosure, stop, unknown, adoption/deployment, workflow and rights changes. After an authorized merge, maintainers confirm the main push CI result and its actual checkout commit.

No workflow automatically merges, deploys, publishes, changes repository permissions or purchases review capacity. Do not bypass a failing protection rule to satisfy an AI reviewer.

## Manual external review

The maintainer checks the service authorization for the exact PR/head, repository access, applicable free allowance and paid-overage controls. A prior single-review approval is not ongoing permission. CodeRabbit can access its selected repository even with automatic reviews disabled. Its [privacy policy](https://www.coderabbit.ai/privacy-policy) includes an OSS training exception; cache and knowledge-base settings do not establish an OSS no-training guarantee. Send only the approved public code and necessary public PR context.

1. Before the request, inspect the head's `.coderabbit.yaml` and confirm the effective manual settings. Changes to review configuration or workflow permissions need maintainer review before they can affect a service run.
2. Once the maintainer authorizes the request, use `@coderabbitai review` once on that PR. It reviews changes since the previous review; see the [official command documentation](https://docs.coderabbit.ai/guides/commands). Do not use paid-credit options, enable automatic continuation, request autofix or alter permissions.
3. Record the review reference, recognized head/configuration, reviewed scope and completed/interrupted/limit-reached status. If the head changes or the reviewed version is unclear, do not count the old review as covering the new version. Wait for the free allowance when it is exhausted; do not automatically retry an uncertain request.
4. Apply the [review criteria](REVIEW_GUIDE.md), record each substantive finding's decision and validation, and check the final changed version. CodeQL dispatches also require a selected version and maintainer authorization; CI success does not trigger them automatically.

Keep public PR evidence limited to the change and its verification. Private service-account records, confidential reports and internal comparison measurements do not belong in a PR. A CodeRabbit review is advisory and never replaces human decisions on authorization or merging.

## Public baseline and maintainer integration

Public `main` is the baseline for public contributions. [Release status](RELEASE_STATUS.md) identifies the recorded published version. The separate shared development checkout still contains subsequent unpublished work and has not completed migration to the public Git history. Publishing a snapshot does not certify or publish that other work.

Maintainers importing a public PR into that checkout compare the public base/head, mapped source/destination SHA-256 hashes and current local changes. They reconcile a three-way diff, preserve concurrent edits, and run the appropriate local regression profile before recording the resulting version. A conflict pauses the affected import until its owner resolves it; it does not justify overwriting newer work. Private requirements, bindings and evidence stay outside the public tree and history.

This transition does not establish two independently maintained application baselines. Until migration is complete, maintainers edit the owning source and regenerate mapped candidates; they do not patch a frozen export independently. Each release candidate binds exact bytes, destinations, tool versions and verification evidence. Any changed input invalidates its previous inspection result. Publication and product distribution remain separate owner decisions.
