# Security policy

## Supported state

No production release or security support lifetime is declared for this development preview source. See [release status](RELEASE_STATUS.md) for the published baseline. Source checks and hosted scanning have limited coverage and cannot prove the absence of secrets or vulnerabilities.

## Reporting

Do not put exploit details, credentials, personal information, ledgers or production logs into public issues, PRs or AI review prompts. Use [Security → Report a vulnerability](https://github.com/youarecolor/OrgManage/security/advisories/new). Private vulnerability reporting was verified enabled on 2026-09-16. Repository maintainers receive reports through GitHub; notification delivery and a response-time commitment have not been established by the source checks. No separate email address or named individual responder is declared.

If the private reporting function is unavailable, report only that a private channel is needed, without sensitive details. Do not substitute a public issue or an AI review prompt for a confidential report.

Include affected source version, a synthetic reproduction, expected and observed behavior, likely impact and any safe mitigation. Avoid live attacks or testing other accounts. If a real secret has already been exposed, the credential owner should revoke or rotate it and investigate exposure; removing a file or rewriting history alone does not revoke a credential.

## CI and review boundary

Public PR content executes only on disposable standard GitHub-hosted runners. No self-hosted runner, development PC, existing VM, real API key, account configuration or production ledger is provided. Workflow write permissions are restricted to the separate CodeQL result-upload job. The build/test job has read-only repository access and checkout does not persist credentials.

CodeRabbit configuration is a review aid, not a security boundary. Installing its App gives the service its approved repository access even if automatic review is disabled. Repository selection, App permissions, data-use terms and paid add-ons require owner review. AI findings cannot change Core authorization or repository protection rules.
