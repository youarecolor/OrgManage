# OrgManage

OrgManage is a local-first workspace for governed AI collaboration. Home brings requests, dialogue, outcomes, evidence and human decisions together. AI proposes a way to work; a deterministic Core decides whether an operation is permitted.

**Development preview source candidate. D14 product acceptance and product distribution are incomplete.** Source inspection, publishing a development preview, D14 completion and distributing a product are four separate milestones. See [release status](RELEASE_STATUS.md).

The designated publication destination is `youarecolor/OrgManage` on GitHub. Publication and external review have not been authorized or performed by this preparation.

## Local synthetic verification

Use Windows and Node.js **24.14.1**. Inspect the registered scripts in `package.json` before execution. From a clean copy of this source candidate:

```powershell
npm ci --ignore-scripts --cache .npm-cache --no-audit --no-fund
npm run verify:public
```

The lockfile fixes development dependency versions. Installation fetches dependencies from the configured registry; dependency lifecycle scripts stay disabled. The verification profile builds source and runs synthetic checks. It does not install or start Electron, connect a provider, qualify a candidate execution environment or exercise a production ledger. Do not supply API keys or personal configuration for CI.

The public profile excludes checks that require protected native protocol installation or fixed VM helper assets. These are **not run** in public CI; read-only rendering and synthetic contracts do not prove native integration, VM admission or real execution. Internal development retains its broader registered verification profile. A public CI pass applies only to the declared public test set.

|Not-run test file (source included)|Reason|
|---|---|
|`tests/host/native-pipe.test.mjs`|Requires an already installed protected native protocol|
|`tests/host/native-prepared-pipe.test.mjs`|Requires an already installed protected native protocol|
|`tests/host/native-preparation.test.mjs`|Checks fixed helper sources/pins containing a private VM binding; those helpers are excluded|
|`tests/core/runner-package.test.mjs`|Checks the same private fixed helper package boundary|

`test:public` reports these exclusions and runs the remaining test files. The internal `npm test` / `verify` keeps the full set. Public contributors can inspect the excluded tests; making them portable requires a separately reviewed binding/profile change, not deleting their acceptance conditions.

## Read next

- [Architecture and boundaries](ARCHITECTURE.md)
- [Contribution process](CONTRIBUTING.md) and [review criteria](REVIEW_GUIDE.md)
- [Security reporting](SECURITY.md)
- [MIT license](LICENSE), [license scope](LICENSE_DECISION.md) and [third-party notice scope](NOTICE.md)
- [Dependency SBOM](dependencies.cdx.json)

OrgManage-authored source is licensed under MIT, Copyright (c) 2026 youarecolor. Dependencies and other third-party material retain their own licenses; unresolved rights evidence remains listed in NOTICE.md. The presence of a lockfile or dependency inventory is not permission to redistribute dependency binaries.
