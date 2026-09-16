# Third-party notice scope

This candidate contains authored source, selected tests, build/configuration files and public documentation. It does not bundle installed dependency trees, Electron/Node runtimes, native binaries or build outputs. Dependency installation is a separate operation driven by the lockfile. This notice records scope and remaining checks; it is not a completed binary-distribution notice set.

The [MIT license](LICENSE), Copyright (c) 2026 youarecolor, applies to OrgManage-authored material. It does not replace the licenses or copyright notices of dependencies and other third-party material. The confirmed project copyright holder does not resolve the third-party evidence gaps below.

The accompanying [dependency SBOM](dependencies.cdx.json) describes dependency metadata for the declared source/build scope, not a claim that every listed component is distributed. Retain upstream license and copyright notices whenever third-party material is actually included. Reassess transitive/runtime/native contents before packaging any executable artifact.

## Rights evidence as of 2026-09-15

|Component|Observed evidence|Remaining limitation|
|---|---|---|
|Rolldown Windows binding 1.2.8|Official same-version [LICENSE](https://raw.githubusercontent.com/rolldown/rolldown/v1.2.8/LICENSE) and [THIRD-PARTY-LICENSE](https://raw.githubusercontent.com/rolldown/rolldown/v1.2.8/THIRD-PARTY-LICENSE) were obtained; parent-package LICENSE bytes matched. SHA-256: `23ecfff35a5a2e80d92142f75228912c3b1abc4b5a8337a821ff4397e2f9f734` and `a877291d800ed43692f3f9ae09d8e01cc6f7293ad39d43896059c188ffbb8b7c`.|The installed binding package lacks its own rights text; all constituent binary rights and distribution notices are not certified.|
|@electron-internal/extract-zip 1.0.5|[Official same-version README](https://github.com/electron/extract-zip/tree/v1.0.5) identifies BSD-2-Clause.|Rights text/holder remains unconfirmed. Do not borrow a similarly named package's license.|
|fast-uri/benchmark 1.0.0, inside fast-uri 3.1.7|Bundled metadata declares ISC.|Benchmark rights text/holder remains unconfirmed. Parent BSD-3-Clause text is not a substitute.|

The earlier inventory recorded three packages lacking local rights text. Obtaining Rolldown's official text advanced one investigation; it did not make the other two disappear or certify binary redistribution. These dependency contents are excluded from source-only extraction. A reviewer must still decide whether the exact source scope and any copied third-party code require further notices before publication.
