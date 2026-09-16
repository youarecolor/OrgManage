# I1-P01 independent contract oracle

`wire-oracle.json` holds literal expected inputs and a canonical string independently derived from the named contract sections. The test author inspected the current specification before reading the implementation. Runtime schemas and generated TypeScript are not used to derive expected outcomes. Tests deliberately distinguish unregistered operations in this packet from operations retained for later implementation.

The packet's explicit implementation choices include root-container depth 1, bytes-only entry, UTF-8 BOM rejection, the `person`/`organization` setup enum, an opaque cursor string shape, and a null owner-binding candidate. These choices do not grant authority or replace the later host/core checks.

Changing an expected result requires its own source or reviewed profile rationale; do not modify the oracle solely to make changed production code pass. Record fixture digests with the implementation verification receipt. Helper builders contain only synthetic IDs and text.

The schema-loader probe runs in a separate trusted local test process and changes only the in-memory file-loader result. It never changes schema files. Its clean/tampered pair checks that runtime validation remains bound to the generated declaration baseline. This is not a candidate Runner isolation test or a signature/authentication test.

Passing these tests establishes only the exercised local syntax, integer-codec, canonicalization, generation-subset and schema-binding behavior. It does not establish DB/CAS round trips, atomic setup, trusted identity, reference authorization, durable receipts, cursor visibility, cancellation observation, external reconciliation, runtime isolation, full acceptance coverage, or any live capability.
