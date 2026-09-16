# Review guide

Review behavior and evidence, not the confidence of an AI explanation. Classify findings as accepted, rejected with reason, deferred with a tracked condition, or duplicate. Record useful findings and maintainer time per PR so the first AI reviewer can be evaluated before adding another service.

|Boundary|Required review questions|
|---|---|
|Deterministic Core|Can model output, candidate content or a display path bypass authorization, policy or protected evaluation?|
|Budget and resources|Are monthly monetary budgets, sub-budgets, holds, unknown costs and runtime resources distinct, bounded and reconciled?|
|Disclosure|Are source, destination, purpose, original version, expiry and revocation bound before sending? Does refusal take priority?|
|Stop|Does a request differ from observed termination? Are late results collected without new unauthorized sends?|
|Unknown|Does unresolved outcome/cost survive restart? Is reconciliation required before retry?|
|Acceptance / ActionApproval|Are outcome acceptance and permission for an exact action separate?|
|Adoption / deployment|Can a candidate alter its evaluator or deploy itself? Are reuse and revocation separately evidenced?|
|Initial E|Is independent evaluation followed by limited adoption, actual other-task use/outcome and revocation? Are synthetic results clearly identified?|
|Standard Executor|Does the API path remain usable with native runtimes disabled, through the same Core and required isolation?|
|Home and extensions|Do daily dialogue, outcomes and approvals stay in Home? Do other surfaces use the same controlled path?|
|Recovery|Do test receipts distinguish normal restart, crash/in-flight recovery, version migration, rollback and actual seven-day recovery?|
|Publication|Are the exact files, rights, provenance, dependency scope and hashes checked? Could scripts, templates or docs disclose private material?|

For high-risk findings, request a minimal synthetic reproduction plus an appropriate regression check. Do not weaken an invariant merely to make an existing test pass. Preserve original requirement IDs and acceptance scope when supplied with a change; missing evidence is unknown or not run, never an inferred pass.
