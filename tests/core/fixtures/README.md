# Independent core oracle fixtures

These tests were authored separately from the core implementation using the effective G08 sections 16.3–16.5, G09 sections 17.4–17.6/17.10, and G11 sections 19.1–19.11. The previously extracted expectations were retained during implementation review.

The fixture host creates trusted synthetic identities and memberships directly. It does not authenticate a real OS user, inspect credentials, qualify process isolation, or grant live provider access. Amounts are simulated integer yen, while actual external cost remains zero. Each test uses a unique database beneath `.private/test-runs/core`; the files remain available for diagnostics. Registered `npm run build` precedes `node --test tests/core/*.test.mjs`.

Bootstrap fault injection wraps the existing synchronous transaction interface and throws at multiple write positions. The test checks real SQLite rollback and absence of a success marker. Membership, policy and additional-Principal fixture writes are trusted scenario setup, never operations exposed to Home.

The tests distinguish accepted command receipt, fake observation result, external outcome unknown, cancellation requested, human acceptance, action approval, and bookkeeping. They are I1 local evidence, not proof of all W02 records, ControlOperation dispatch, real cancellation, charge corrections/refunds, seven-day recovery, OS rights, or D14 acceptance.
