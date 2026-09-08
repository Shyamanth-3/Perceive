import assert from 'assert';
import { detectPII } from './pii-patterns.js';
import { classifyElement } from './dom-heuristics.js';
import { classifySensitivity, classifyActionRisk } from './sensitivity-tiers.js';
import { createTokenVault } from './token-vault.js';
import { getVaultForSession, endSession, getActiveSessionCount, cleanExpiredSessions } from './session-vault-manager.js';
import { auditPayload, assertSafeToSend, createSecureTransport } from './leakage-auditor.js';
import { processPageForRedaction } from './redaction-engine.js';
import { checkChannelConsistency, assertChannelsConsistent } from './channel-consistency-check.js';

console.log('=== RUNNING DEV 2 PRIVACY PIPELINE VERIFICATION SUITE ===\n');

let passCount = 0;
let totalCount = 0;

function runTestCase(name, fn) {
  totalCount++;
  try {
    fn();
    passCount++;
    console.log(`[PASS] Test ${totalCount}: ${name}`);
  } catch (err) {
    console.error(`[FAIL] Test ${totalCount}: ${name}\n  Error: ${err.message}`);
    throw err;
  }
}

// 1. CARD_NUMBER detection -> sensitivity_tier = 1
runTestCase('CARD_NUMBER detection -> sensitivity_tier = 1', () => {
  const cardElementClass = { tag: 'input', role: null, label_text: 'Card Number', is_sensitive: true, sensitivity_type: 'CARD_NUMBER' };
  const cardPii = detectPII('4111 1111 1111 1111');
  assert.strictEqual(cardPii.length, 1);
  assert.strictEqual(cardPii[0].type, 'CARD_NUMBER');

  const vault = createTokenVault();
  const res = classifySensitivity(cardElementClass, cardPii, '4111 1111 1111 1111', vault);
  assert.strictEqual(res.sensitivity_tier, 1, 'CARD_NUMBER detection must have sensitivity_tier = 1');
  assert.strictEqual(res.sensitivity_type, 'CARD_NUMBER');
  assert.strictEqual(res.semantic_token, '[CARD_NUMBER_1]');
});

// 2. CARD_NUMBER typing action -> risk_tier = "risky"
runTestCase('CARD_NUMBER typing action -> risk_tier = "risky"', () => {
  const action = {
    type: 'type',
    target_element_id: 'card-number-input',
    value: '[CARD_NUMBER_1]'
  };
  const riskTier = classifyActionRisk(action);
  assert.strictEqual(riskTier, 'risky', 'CARD_NUMBER typing action must have risk_tier = "risky"');
  assert.notStrictEqual(riskTier, 1, 'risk_tier MUST NOT be numeric 1');
});

// 3. Normal safe action -> risk_tier = "safe"
runTestCase('Normal safe action -> risk_tier = "safe"', () => {
  const action = {
    type: 'click',
    target_element_id: 'nav-home-link',
    value: null
  };
  const riskTier = classifyActionRisk(action);
  assert.strictEqual(riskTier, 'safe', 'Normal action must have risk_tier = "safe"');
  assert.notStrictEqual(riskTier, 3, 'risk_tier MUST NOT be numeric 3');
});

// 4. Semantic token [CARD_NUMBER_1] format
runTestCase('Semantic token [CARD_NUMBER_1] format', () => {
  const vault = createTokenVault();
  const token = vault.getOrCreateToken('4111 1111 1111 1111', 'CARD_NUMBER');
  assert.strictEqual(token, '[CARD_NUMBER_1]', 'Semantic token format must remain [CARD_NUMBER_1]');
});

// 5. assertSafeToSend() still blocks raw PII
runTestCase('assertSafeToSend() still blocks raw PII', () => {
  const cleanPayload = {
    dom_summary: {
      elements: [{ element_id: 'c1', semantic_token: '[CARD_NUMBER_1]' }]
    }
  };
  assert.doesNotThrow(() => assertSafeToSend(cleanPayload, detectPII));

  const leakedPayload = {
    dom_summary: {
      elements: [{ element_id: 'c1', label_text: '4111 1111 1111 1111' }]
    }
  };
  assert.throws(() => assertSafeToSend(leakedPayload, detectPII), /Payload safety audit failed/);
});

// 6. Basic Token Vault session isolation
runTestCase('Basic Token Vault session isolation', () => {
  const sessionId = 'session-test-basic';
  const vault = getVaultForSession(sessionId);
  const token = vault.getOrCreateToken('user@example.com', 'EMAIL');
  assert.strictEqual(token, '[EMAIL_1]');
  assert.strictEqual(vault.resolveToken('[EMAIL_1]'), 'user@example.com');

  endSession(sessionId);
  assert.strictEqual(vault.resolveToken('[EMAIL_1]'), null);
});

// 7. Verify numeric risk_tier conversion
runTestCase('Numeric risk_tier converted properly to string enum ("safe" | "risky")', () => {
  const actionWithNumeric1 = { type: 'type', target_element_id: 'card-input', value: '[CARD_NUMBER_1]', risk_tier: 1 };
  assert.strictEqual(classifyActionRisk(actionWithNumeric1), 'risky');

  const actionWithNumeric3 = { type: 'click', target_element_id: 'btn-back', risk_tier: 3 };
  assert.strictEqual(classifyActionRisk(actionWithNumeric3), 'safe');
});

// 8. Specific validation of sensitivity_tier (1, 2, 3) & action risk_tier ("safe", "risky")
runTestCase('sensitivity_tier (1,2,3) & action risk_tier ("safe","risky") strictly validated', () => {
  const tier1Res = classifySensitivity({ sensitivity_type: 'CARD_NUMBER' }, []);
  assert.strictEqual(tier1Res.sensitivity_tier, 1);

  const tier2Res = classifySensitivity({ sensitivity_type: 'EMAIL' }, []);
  assert.strictEqual(tier2Res.sensitivity_tier, 2);

  const tier3Res = classifySensitivity({ sensitivity_type: 'UNKNOWN' }, []);
  assert.strictEqual(tier3Res.sensitivity_tier, 3);

  const safeAction = { type: 'click', target_element_id: 'btn-home', risk_tier: 'safe' };
  assert.strictEqual(classifyActionRisk(safeAction), 'safe');

  const riskyAction = { type: 'type', target_element_id: 'card-input', risk_tier: 'risky' };
  assert.strictEqual(classifyActionRisk(riskyAction), 'risky');
});

// Helper mocks for E2E tests
const validBase64Padding = 'A'.repeat(120);
const mockCanvas = {
  getContext: () => ({
    fillRect: () => {},
    clearRect: () => {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) })
  }),
  toDataURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' + validBase64Padding
};

// --- END-TO-END SPECIFIC VERIFICATION TEST CASES (1-12) ---

// E2E Test 1: Tier-1 card number full pipeline flow
runTestCase('E2E Case 1: Tier-1 card number full pipeline flow', () => {
  const mockCardElement = {
    id: 'card-input-e2e',
    tagName: 'INPUT',
    type: 'text',
    value: '4111 1111 1111 1111',
    getAttribute: (attr) => (attr === 'autocomplete' ? 'cc-number' : null),
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 200, height: 30 })
  };

  const vault = createTokenVault();
  const payload = processPageForRedaction([mockCardElement], mockCanvas, vault);

  // Assert Tier 1 & token creation
  const cardElem = payload.dom_summary.elements[0];
  assert.strictEqual(cardElem.sensitivity_tier, 1);
  assert.strictEqual(cardElem.semantic_token, '[CARD_NUMBER_1]');
  assert.strictEqual(cardElem.is_sensitive, true);

  // Assert visual region metadata created
  assert.strictEqual(payload.redacted_regions.length, 1);
  assert.strictEqual(payload.redacted_regions[0].element_id, 'card-input-e2e');

  // Assert dual-channel consistency & leak audit pass
  assert.doesNotThrow(() => assertChannelsConsistent(payload, payload.redacted_regions));
  assert.doesNotThrow(() => assertSafeToSend(payload, detectPII));
});

// E2E Test 2: Same card appears again in the same session -> reuse token
runTestCase('E2E Case 2: Same card appears again in same session -> reuse [CARD_NUMBER_1]', () => {
  const vault = createTokenVault();
  const t1 = vault.getOrCreateToken('4111 1111 1111 1111', 'CARD_NUMBER');
  const t2 = vault.getOrCreateToken('4111 1111 1111 1111', 'CARD_NUMBER');

  assert.strictEqual(t1, '[CARD_NUMBER_1]');
  assert.strictEqual(t2, t1, 'Must strictly reuse exact same token instance');
});

// E2E Test 3: Different card in same session -> receives different token
runTestCase('E2E Case 3: Different card in same session -> receives [CARD_NUMBER_2]', () => {
  const vault = createTokenVault();
  const t1 = vault.getOrCreateToken('4111 1111 1111 1111', 'CARD_NUMBER');
  const t2 = vault.getOrCreateToken('5500 0000 0000 0004', 'CARD_NUMBER');

  assert.strictEqual(t1, '[CARD_NUMBER_1]');
  assert.strictEqual(t2, '[CARD_NUMBER_2]');
  assert.notStrictEqual(t1, t2);
});

// E2E Test 4: Same card in another session -> session isolation guaranteed
runTestCase('E2E Case 4: Same card in another session -> no token state sharing across sessions', () => {
  const sessionA = 'session-alpha-123';
  const sessionB = 'session-beta-456';

  const vaultA = getVaultForSession(sessionA);
  const vaultB = getVaultForSession(sessionB);

  const tA = vaultA.getOrCreateToken('4111 1111 1111 1111', 'CARD_NUMBER');
  const tB = vaultB.getOrCreateToken('4111 1111 1111 1111', 'CARD_NUMBER');

  assert.strictEqual(tA, '[CARD_NUMBER_1]');
  assert.strictEqual(tB, '[CARD_NUMBER_1]'); // Both start index at 1 independently

  // Verify resolution maps are isolated per session
  endSession(sessionA);
  assert.strictEqual(vaultA.resolveToken('[CARD_NUMBER_1]'), null);
  assert.strictEqual(vaultB.resolveToken('[CARD_NUMBER_1]'), '4111 1111 1111 1111');

  endSession(sessionB);
});

// E2E Test 5: Token resolution locally & raw value absent from payload
runTestCase('E2E Case 5: Token resolves to raw value locally, absent from outgoing payload', () => {
  const vault = createTokenVault();
  const mockCardElement = {
    id: 'card-input-5',
    tagName: 'INPUT',
    type: 'text',
    value: '4111 1111 1111 1111',
    getAttribute: (attr) => (attr === 'autocomplete' ? 'cc-number' : null),
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 200, height: 30 })
  };

  const payload = processPageForRedaction([mockCardElement], mockCanvas, vault);

  // Local resolution succeeds
  assert.strictEqual(vault.resolveToken('[CARD_NUMBER_1]'), '4111 1111 1111 1111');

  // Outgoing payload contains NO raw PII string anywhere
  const payloadStr = JSON.stringify(payload);
  assert.strictEqual(payloadStr.includes('4111 1111 1111 1111'), false);
  assert.strictEqual(payloadStr.includes('4111111111111111'), false);
});

// E2E Test 6: Layer 4 mismatch -> fails closed
runTestCase('E2E Case 6: Layer 4 mismatch -> fails closed', () => {
  const mockCardElement = {
    id: 'card-input-6',
    tagName: 'INPUT',
    type: 'text',
    value: '4111 1111 1111 1111',
    getAttribute: (attr) => (attr === 'autocomplete' ? 'cc-number' : null),
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 200, height: 30 })
  };

  const vault = createTokenVault();
  const payload = processPageForRedaction([mockCardElement], mockCanvas, vault);

  // Omit visual redaction region to simulate visual engine failure
  const corruptedRegions = [];

  assert.throws(
    () => assertChannelsConsistent(payload, corruptedRegions),
    /Channel consistency check failed/
  );
});

// E2E Test 7: Leak injection -> auditor rejects & zero transport calls
runTestCase('E2E Case 7: Leak injection -> auditor rejects & zero transport calls', () => {
  let calls = 0;
  const mockTransport = () => { calls++; };
  const send = createSecureTransport(mockTransport, detectPII);

  const leakedPayload = {
    redacted_image_base64: 'A'.repeat(120),
    dom_summary: {
      elements: [
        {
          element_id: 'elem-7',
          semantic_token: '[CARD_NUMBER_1]',
          nestedMetadata: {
            leakedCard: '4111 1111 1111 1111'
          }
        }
      ]
    }
  };

  assert.throws(() => send(leakedPayload), /Payload safety audit failed/);
  assert.strictEqual(calls, 0, 'Transport MUST NOT be invoked when leakage auditor rejects payload');
});

// E2E Test 8: Safe semantic token allowed through sanitized payload
runTestCase('E2E Case 8: [CARD_NUMBER_1] semantic token allowed through payload', () => {
  let calls = 0;
  const mockTransport = () => { calls++; };
  const send = createSecureTransport(mockTransport, detectPII);

  const cleanPayload = {
    redacted_image_base64: 'A'.repeat(120),
    dom_summary: {
      url: 'https://checkout.example.com',
      elements: [{ element_id: 'card-1', semantic_token: '[CARD_NUMBER_1]' }]
    }
  };

  assert.doesNotThrow(() => send(cleanPayload));
  assert.strictEqual(calls, 1);
});

// E2E Test 9: Session cleanup (task_complete clears vault)
runTestCase('E2E Case 9: Session cleanup (task_complete clears vault)', () => {
  const sessionId = 'session-complete-9';
  const vault = getVaultForSession(sessionId);
  vault.getOrCreateToken('user@example.com', 'EMAIL');

  assert.strictEqual(getActiveSessionCount() >= 1, true);

  // Simulate task_complete cleanup
  endSession(sessionId);

  assert.strictEqual(vault.resolveToken('[EMAIL_1]'), null);
  assert.strictEqual(vault.getStats().totalTokens, 0);
});

// E2E Test 10: Failure cleanup (task_failed clears vault)
runTestCase('E2E Case 10: Failure cleanup (task_failed clears vault)', () => {
  const sessionId = 'session-failed-10';
  const vault = getVaultForSession(sessionId);
  vault.getOrCreateToken('4111 1111 1111 1111', 'CARD_NUMBER');

  // Simulate task_failed error recovery teardown
  try {
    throw new Error('Simulated task execution error');
  } catch (err) {
    endSession(sessionId);
  }

  assert.strictEqual(vault.resolveToken('[CARD_NUMBER_1]'), null);
  assert.strictEqual(vault.getStats().totalTokens, 0);
});

// E2E Test 11: Timeout/expired session behavior -> vault invalidated on expiration
runTestCase('E2E Case 11: Timeout/expired session behavior -> vault invalidated after TTL', () => {
  const sessionId = 'session-expired-11';
  // Retrieve vault with 1ms TTL
  const vault1 = getVaultForSession(sessionId, 1);
  vault1.getOrCreateToken('4111 1111 1111 1111', 'CARD_NUMBER');

  // Busy wait 5ms to guarantee expiration
  const start = Date.now();
  while (Date.now() - start < 5) {}

  // Requesting vault after TTL should trigger automatic expiration cleanup & return a fresh vault
  const vault2 = getVaultForSession(sessionId, 1);
  assert.notStrictEqual(vault1, vault2, 'Expired session must return a fresh new vault instance');
  assert.strictEqual(vault2.resolveToken('[CARD_NUMBER_1]'), null, 'Expired tokens must not resolve');

  endSession(sessionId);
});

// E2E Test 12: Final payload inspection -> recursive proof no raw PII exists anywhere
runTestCase('E2E Case 12: Final payload inspection -> recursive proof no raw sensitive values exist anywhere', () => {
  const mockCard = {
    id: 'card-12',
    tagName: 'INPUT',
    type: 'text',
    value: '4111 1111 1111 1111',
    getAttribute: (attr) => (attr === 'autocomplete' ? 'cc-number' : null),
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 200, height: 30 })
  };

  const mockEmail = {
    id: 'email-12',
    tagName: 'INPUT',
    type: 'email',
    value: 'user12@example.com',
    getAttribute: (attr) => (attr === 'autocomplete' ? 'email' : null),
    getBoundingClientRect: () => ({ x: 10, y: 60, width: 200, height: 30 })
  };

  const mockPwd = {
    id: 'pwd-12',
    tagName: 'INPUT',
    type: 'password',
    value: 'SuperSecret12!Pass',
    getAttribute: (attr) => (attr === 'type' ? 'password' : null),
    getBoundingClientRect: () => ({ x: 10, y: 100, width: 200, height: 30 })
  };

  const vault = createTokenVault();
  const payload = processPageForRedaction([mockCard, mockEmail, mockPwd], mockCanvas, vault);

  const rawValuesToVerify = ['4111 1111 1111 1111', '4111111111111111', 'user12@example.com', 'SuperSecret12!Pass'];

  function walkObject(node, path = '') {
    if (node === null || node === undefined) return;
    if (path === 'redacted_image_base64') return;

    if (typeof node === 'string') {
      for (const rawVal of rawValuesToVerify) {
        assert.strictEqual(
          node.includes(rawVal),
          false,
          `Raw sensitive value "${rawVal}" MUST NOT exist in payload string at path "${path}"`
        );
      }
      return;
    }

    if (typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        walkObject(node[i], `${path}[${i}]`);
      }
      return;
    }

    for (const key of Object.keys(node)) {
      walkObject(node[key], path ? `${path}.${key}` : key);
    }
  }

  walkObject(payload);
});

console.log(`\n--- ALL ${passCount} / ${totalCount} DEV 2 TESTS PASSED SUCCESSFULLY ---`);
