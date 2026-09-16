# Architecture

## One command and decision path

Home is the daily interface for requests, conversation, outcomes and decisions. A selection component proposes a permitted configuration; the Core checks authority, information disclosure, budget, stop state and evidence before execution. Display surfaces cannot independently grant access.

The initial implementation uses TypeScript, a SQLite ledger, React Home and an Electron shell. Contracts, deterministic Core, trusted host, isolated candidate runner and display-only preview remain distinct responsibilities even where packages are physically grouped.

## State and authority

|Concept|Meaning|
|---|---|
|Acceptance|A human decision about whether an outcome meets the task requirements|
|ActionApproval|Permission for a particular operation, scope, version and expiry|
|Run / Attempt|Shared execution and accounting records; not a provider's native session|
|Stop request|A recorded request to stop; observed termination requires separate evidence|
|Unknown|An unresolved external outcome or cost that survives restart until reconciliation|
|Candidate|An immutable proposed change, with no authority to adopt or deploy itself|
|Capability evidence|A result scoped to a route, purpose, version, configuration and expiry|

Information access binds sources to allowed destinations and purposes, with refusal taking priority. Source versions, provenance and revocation matter throughout retrieval, disclosure and reuse. Monetary budget and runtime resource limits are distinct constraints; unresolved costs retain their obligation until evidence resolves them.

## Execution and learning

The standard Executor uses a finite loop under Core control. D14 requires a real small change through an authorized API with native runtimes disabled. Candidate application, build, evaluation and collection require the relevant isolation and lease evidence. Successful API communication alone does not qualify code execution.

Initial E is a required learning loop: a specific failure leads to a candidate, independent evaluation, limited adoption, a role index, evidenced use and outcome in another task, and revocation when needed. A synthetic demonstration or candidate generation alone does not establish real learning effectiveness.

Persona, model, reasoning depth, prompt, context, tools, runtime and payment route remain separate. Auto routing must respect permitted configurations and evidence for every possible result; it cannot silently drop reasoning settings or expand access. Reuse of knowledge, adoption and deployment have separate decisions.

## Recovery and extension

Restart must preserve unknown outcomes, authorization identity and audit continuity. Updating requires planned safe stop, a health check with dispatch disabled, and evidence that rollback restores the intended state. A normal stop-and-copy experiment does not establish crash recovery, in-flight recovery, version migration or actual seven-day retrieval.

Future remote, office/game, voice and 3D surfaces use the same command and approval contracts. Early bounded Rust/Go comparisons may inform selected components; full implementations in three languages are not required. None of these future surfaces replace the initial Home, standard Executor or E requirements.
