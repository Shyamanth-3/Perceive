## E2E Test Results — [timestamp]

### Positive Case (A → K)
- [ ] A: Sandbox page loaded, all element IDs present
- [ ] B: Session started, UUID generated, vault obtained
- [ ] C: DOM capture returned 13 elements
- [ ] D: Sensitivity tiers assigned correctly (7/7 match)
- [ ] E: Semantic tokens generated (7/7)
- [ ] E-TS: Token stability — saved card + input card → same [CARD_NUMBER_1] ✓
- [ ] F: Payload leakage guard: PASSED
- [ ] G: Backend round-trip: 200 OK, valid action
- [ ] H: Email typed via resolveToken (single call verified)
- [ ] I: Password typed via resolveToken (no console output verified)
- [ ] J: Login submit auto-executed (risk_tier=safe)
- [ ] K: Pay Now confirmation shown (risk_tier=risky), approved, executed

### Negative Case
- [ ] NEG-1: Unknown token gracefully failed, retry triggered, no crash

### Exit Path Coverage (Orphaned Session Prevention)
- [ ] EXIT-1: completed → finalizeTask called, vault deleted
- [ ] EXIT-2: failed_by_server → finalizeTask called, vault deleted
- [ ] EXIT-3: denied_by_user → finalizeTask called, vault deleted
- [ ] EXIT-4: max_retries_exceeded → finalizeTask called, vault deleted
- [ ] EXIT-5: max_steps_exceeded → finalizeTask called, vault deleted
- [ ] EXIT-6: fatal_error → finalizeTask called, vault deleted
- [ ] ORPHAN-CHECK: Active vaults after all runs = 0

Result: **0/20 PASSED**
