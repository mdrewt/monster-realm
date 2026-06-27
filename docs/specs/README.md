# Project specs (`docs/specs/`)

**The authoritative spec corpus for monster-realm lives in the harness, not here.**

From the project root (`projects/monster-realm/`) it is:

    ../../specs/monster-realm-v2/

That directory holds the milestone specs (`M0`–`M9`, including
`M8.5-hardening-remediation` and `M8.6-residual-hardening`), `PLAN.md`,
`game-design.md`, `security-threat-model.md`, `validation-checklist.md`, and the
**design ADRs `0001`–`0034`** under `adr/`.

This `docs/specs/` directory is for **project-local** specs and `TEMPLATE.md`.
**Implementation ADRs (`0001`, `0035`+) live in [`../adr/`](../adr/).**

When you (or an agent) are told *"see the spec"* or *"ADR-00NN"*:

| Reference | Look in |
|---|---|
| A milestone spec (`M0`…`M9`, `M8.5`, `M8.6`) | harness `specs/monster-realm-v2/` |
| ADR `0002`–`0034` (design corpus) | harness `specs/monster-realm-v2/adr/` |
| ADR `0035`+ (implementation) | `docs/adr/` |
| ADR `0001` | either (mirrored) |

See also the project [`AGENTS.md`](../../AGENTS.md) "Notes" section.
