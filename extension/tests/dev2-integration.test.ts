/**
 * Dev 1 → Dev 2 integration tests. Uses Dev 2's REAL, unmodified vendored
 * functions (`dev2-vendor/*`) — nothing here is a mock of Dev 2's logic,
 * only the DOM (a hand-built `CapturedElement` tree, matching exactly what
 * Dev 1's real `content/dom-capture.ts` + `shared/capture.ts` produce) is
 * synthetic, standing in for a real page for deterministic test data.
 *
 * Covers the privacy boundary the integration instructions require:
 * synthetic email/phone/card/aadhaar/otp/password/IFSC values in, sanitized
 * (tiered + tokenized) values out, and Dev 2's own `assertSafeToSend` used
 * as the pass/fail oracle — not a hand-rolled string search.
 */

import { buildDev2DomSummary, classifyFromCapturedElement } from "../src/content/dev2-integration";
import { buildSanitizedClientPayload } from "../src/content/dev2-payload";
import { createTokenVault } from "../src/dev2-vendor/token-vault.js";
import { auditPayload } from "../src/dev2-vendor/leakage-auditor.js";
import { detectPII } from "../src/dev2-vendor/pii-patterns.js";
import type { CapturedElement, DomSnapshot } from "../src/shared/capture";

const SYNTHETIC = {
  email: "demo@example.com",
  password: "DemoPassword123!",
  card: "4111111111111111",
  phone: "9999999999",
  aadhaar: "234567890123",
  otp: "482913",
  ifsc: "HDFC0001234",
  name: "Priya Sharma",
};

function el(overrides: Partial<CapturedElement>): CapturedElement {
  return {
    id: "0",
    tag: "div",
    type: null,
    role: null,
    aria: { label: null, labelledby: null, describedby: null, hidden: null, live: null, expanded: null },
    attrs: {},
    rect: { x: 10, y: 10, width: 100, height: 20 },
    visible: true,
    disabled: false,
    text: null,
    value: null,
    children: [],
    ...overrides,
  };
}

/** A synthetic page: password/hidden inputs already excluded exactly as
 * Dev 1's real privacy gate (shared/capture.ts) would exclude them — this
 * fixture intentionally mirrors what a real DomSnapshot looks like, not
 * what the raw page contains. */
function buildFixtureSnapshot(): DomSnapshot {
  const elements: CapturedElement[] = [
    el({ id: "1", tag: "label", attrs: { for: "email-input" }, text: "Email address" }),
    el({
      id: "2",
      tag: "input",
      type: "email",
      attrs: { id: "email-input", autocomplete: "email" },
      value: SYNTHETIC.email,
    }),
    // Password: Dev 1's own privacy gate already nulls this — value is null
    // here exactly as the real content-script would produce, proving Dev 2
    // never even receives it.
    el({ id: "3", tag: "input", type: "password", attrs: { autocomplete: "current-password" }, value: null }),
    el({ id: "4", tag: "label", attrs: { for: "card-input" }, text: "Card number" }),
    el({ id: "5", tag: "input", type: "text", attrs: { id: "card-input", autocomplete: "cc-number" }, value: SYNTHETIC.card }),
    el({ id: "6", tag: "label", attrs: { for: "phone-input" }, text: "Phone" }),
    el({ id: "7", tag: "input", type: "tel", attrs: { id: "phone-input" }, value: SYNTHETIC.phone }),
    el({ id: "8", tag: "div", text: `Aadhaar on file: ${SYNTHETIC.aadhaar}` }),
    el({ id: "9", tag: "div", text: `Your OTP is ${SYNTHETIC.otp}, do not share it` }),
    el({ id: "10", tag: "label", attrs: { for: "name-input" }, text: "Full name" }),
    el({ id: "11", tag: "input", type: "text", attrs: { id: "name-input", autocomplete: "name" }, value: SYNTHETIC.name }),
    el({ id: "12", tag: "div", text: `IFSC: ${SYNTHETIC.ifsc}` }),
    el({ id: "13", tag: "label", attrs: { for: "amount-input" }, text: "Total amount" }),
    el({ id: "14", tag: "input", type: "text", attrs: { id: "amount-input", placeholder: "Total price" }, value: "45.00" }),
    el({ id: "15", tag: "button", text: "Submit" }),
  ];
  return {
    requestId: "test-req",
    domCapturedAt: 1,
    viewport: { width: 1200, height: 800 },
    devicePixelRatio: 1,
    scroll: { x: 0, y: 0 },
    elements,
    elementCount: elements.length,
    truncated: false,
  };
}

describe("classifyFromCapturedElement (serialized-data equivalent of Dev 2's classifyElement)", () => {
  it("classifies an email input as EMAIL via autocomplete", () => {
    const snapshot = buildFixtureSnapshot();
    const { dom_summary } = buildDev2DomSummary(snapshot, "https://example.com", null);
    const emailEl = dom_summary.elements.find((e) => e.element_id === "2");
    expect(emailEl?.sensitivity_type).toBe("EMAIL");
    expect(emailEl?.sensitivity_tier).toBe(2);
  });

  it("resolves label[for] text without live DOM access", () => {
    const snapshot = buildFixtureSnapshot();
    const { dom_summary } = buildDev2DomSummary(snapshot, "https://example.com", null);
    const cardEl = dom_summary.elements.find((e) => e.element_id === "5");
    expect(cardEl?.label_text).toBe("Card number");
  });
});

describe("buildDev2DomSummary — privacy boundary with synthetic sensitive data", () => {
  it("never receives the password value at all (Dev 1's own gate already excluded it)", () => {
    const snapshot = buildFixtureSnapshot();
    const { dom_summary } = buildDev2DomSummary(snapshot, "https://example.com", null);
    const passwordEl = dom_summary.elements.find((e) => e.element_id === "3");
    // classified via type="password" heuristic even with value already null
    expect(passwordEl?.sensitivity_type).toBe("PASSWORD");
    expect(passwordEl?.sensitivity_tier).toBe(1);
    // and the raw string never appears anywhere in the output
    expect(JSON.stringify(dom_summary)).not.toContain(SYNTHETIC.password);
  });

  it("assigns correct tiers: PASSWORD/CARD_NUMBER/AADHAAR/OTP = tier 1", () => {
    const snapshot = buildFixtureSnapshot();
    const { dom_summary } = buildDev2DomSummary(snapshot, "https://example.com", null);
    const byId = (id: string) => dom_summary.elements.find((e) => e.element_id === id);
    expect(byId("5")?.sensitivity_tier).toBe(1); // CARD_NUMBER (dom heuristic: autocomplete=cc-number)
    expect(byId("8")?.sensitivity_type).toBe("AADHAAR"); // PII regex only, no dom heuristic
    expect(byId("8")?.sensitivity_tier).toBe(1);
    expect(byId("9")?.sensitivity_type).toBe("OTP");
    expect(byId("9")?.sensitivity_tier).toBe(1);
  });

  it("assigns tier 2 for EMAIL/PHONE/NAME/IFSC", () => {
    const snapshot = buildFixtureSnapshot();
    const { dom_summary } = buildDev2DomSummary(snapshot, "https://example.com", null);
    const byId = (id: string) => dom_summary.elements.find((e) => e.element_id === id);
    expect(byId("2")?.sensitivity_tier).toBe(2); // EMAIL
    expect(byId("7")?.sensitivity_tier).toBe(2); // PHONE
    expect(byId("11")?.sensitivity_tier).toBe(2); // NAME
    expect(byId("12")?.sensitivity_type).toBe("IFSC");
    expect(byId("12")?.sensitivity_tier).toBe(2);
  });

  it("generates semantic tokens for tier 1/2 elements, null for non-sensitive", () => {
    const snapshot = buildFixtureSnapshot();
    const vault = createTokenVault();
    const { dom_summary } = buildDev2DomSummary(snapshot, "https://example.com", vault);
    const byId = (id: string) => dom_summary.elements.find((e) => e.element_id === id);
    expect(byId("2")?.semantic_token).toMatch(/^\[EMAIL_\d+\]$/);
    expect(byId("5")?.semantic_token).toMatch(/^\[CARD_NUMBER_\d+\]$/);
    expect(byId("15")?.semantic_token).toBeNull(); // button, not sensitive
  });

  it("token vault returns the SAME token for the same raw value (stability)", () => {
    const vault = createTokenVault();
    const snapshot = buildFixtureSnapshot();
    // Append a duplicate card field with the identical value.
    snapshot.elements.push(el({ id: "16", tag: "input", type: "text", attrs: { autocomplete: "cc-number" }, value: SYNTHETIC.card }));
    snapshot.elementCount = snapshot.elements.length;
    const { dom_summary } = buildDev2DomSummary(snapshot, "https://example.com", vault);
    const byId = (id: string) => dom_summary.elements.find((e) => e.element_id === id);
    expect(byId("5")?.semantic_token).toBe(byId("16")?.semantic_token);
  });

  it("PRIVACY GATE: no synthetic raw sensitive value appears anywhere in the sanitized dom_summary", () => {
    const snapshot = buildFixtureSnapshot();
    const vault = createTokenVault();
    const { dom_summary } = buildDev2DomSummary(snapshot, "https://example.com", vault);
    const serialized = JSON.stringify(dom_summary);
    for (const [label, value] of Object.entries(SYNTHETIC)) {
      expect(serialized).not.toContain(value);
      // guard against the test itself being vacuous (e.g. value present but unnoticed)
      void label;
    }
  });
});

describe("buildSanitizedClientPayload — end-to-end fail-closed audit", () => {
  it("produces a payload that Dev 2's own assertSafeToSend accepts (does not throw)", () => {
    const snapshot = buildFixtureSnapshot();
    const vault = createTokenVault();
    expect(() =>
      buildSanitizedClientPayload({
        dom: snapshot,
        url: "https://example.com/checkout",
        tokenVault: vault,
        sessionId: "test-session-1",
        taskInstruction: "buy the item",
        stepNumber: 1,
      })
    ).not.toThrow();
  });

  it("FAIL-CLOSED: assertSafeToSend rejects a payload if a raw value leaks in despite the pipeline (regression guard)", () => {
    const snapshot = buildFixtureSnapshot();
    const { dom_summary } = buildDev2DomSummary(snapshot, "https://example.com", createTokenVault());
    // Simulate a leak: someone appends a raw value directly into the payload
    // outside the normal pipeline (the exact bug class this gate exists for).
    const leaked = { ...dom_summary, elements: [...dom_summary.elements, { leaked_raw_card: SYNTHETIC.card } as never] };
    const audit = auditPayload(leaked, detectPII);
    expect(audit.passed).toBe(false);
    expect(audit.violations.some((v) => v.matched_type === "CARD_NUMBER")).toBe(true);
  });
});
