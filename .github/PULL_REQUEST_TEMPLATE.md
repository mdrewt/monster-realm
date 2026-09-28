## What & why
<!-- Summarize the change and why it is needed. -->

## Checklist
- [ ] `just ci` green (and `just e2e` if netcode, reducers or client flows changed)
- [ ] Failing test written before the change
- [ ] `docs/DECISIONS.md` updated if a design decision changed
- [ ] No secrets; inputs validated at the reducer boundary
