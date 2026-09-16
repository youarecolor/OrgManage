# Security policy

## Supported state

No production release or security support lifetime is declared for this development source candidate. Source checks and hosted scanning have limited coverage and cannot prove the absence of secrets or vulnerabilities.

## Reporting

Do not put exploit details, credentials, personal information, ledgers or production logs into public issues, PRs or AI review prompts. The planned reporting channel is **Security → Report a vulnerability** in the designated GitHub repository `youarecolor/OrgManage`. Repository publication and private reporting have not been enabled or verified by this preparation. Once enabled by the owner, use that private reporting function. If it is absent, report only that a private reporting channel is needed, without sensitive details. A working private reporting channel and response responsibility must be verified before publication; no email address or individual responder is inferred in this candidate.

Include affected source version, a synthetic reproduction, expected and observed behavior, likely impact and any safe mitigation. Avoid live attacks or testing other accounts. If a real secret has already been exposed, the credential owner should revoke or rotate it and investigate exposure; removing a file or rewriting history alone does not revoke a credential.

## CI and review boundary

Public PR content executes only on disposable standard GitHub-hosted runners. No self-hosted runner, development PC, existing VM, real API key, account configuration or production ledger is provided. Workflow write permissions are restricted to the separate CodeQL result-upload job. The build/test job has read-only repository access and checkout does not persist credentials.

CodeRabbit configuration is a review aid, not a security boundary. Installing its App gives the service its approved repository access even if automatic review is disabled. Repository selection, App permissions, data-use terms and paid add-ons require owner review. AI findings cannot change Core authorization or repository protection rules.
