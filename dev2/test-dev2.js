import assert from 'assert';
import { detectPII } from './pii-patterns.js';
import { classifyElement } from './dom-heuristics.js';
import { classifySensitivity, classifyActionRisk } from './sensitivity-tiers.js';
import { createTokenVault } from './token-vault.js';
import { getVaultForSession, endSession, getActiveSessionCount } from './session-vault-manager.js';
import { auditPayload, assertSafeToSend } from './leakage-auditor.js';

console.log('--- RUNNING DEV 2 TESTS ---');

// 1. CARD_NUMBER detection -> sensitivity_tier = 1
{
  const cardElementClass = { tag: 'input', role: null, label_text: 'Card Number', is_sensitive: true, sensitivity_type: 'CARD_NUMBER' };
  const cardPii = detectPII('4111 1111 1111 1111');
  assert.strictEqual(cardPii.length, 1);
  assert.strictEqual(cardPii[0].type, 'CARD_NUMBER');

  const vault = createTokenVault();
  const res = classifySensitivity(cardElementClass, cardPii, '4111 1111 1111 1111', vault);
  assert.strictEqual(res.sensitivity_tier, 1, 'CARD_NUMBER detection must have sensitivity_tier = 1');
  assert.strictEqual(res.sensitivity_type, 'CARD_NUMBER');
  assert.strictEqual(res.semantic_token, '[CARD_NUMBER_1]');
  console.log('✔ Test 1 Passed: CARD_NUMBER detection -> sensitivity_tier = 1');
}

// 2. CARD_NUMBER typing action -> risk_tier = "risky"
{
  const action = {
    type: 'type',
    target_element_id: 'card-number-input',
    value: '[CARD_NUMBER_1]'
  };
  const riskTier = classifyActionRisk(action);
  assert.strictEqual(riskTier, 'risky', 'CARD_NUMBER typing action must have risk_tier = "risky"');
  assert.notStrictEqual(riskTier, 1, 'risk_tier MUST NOT be numeric 1');
  console.log('✔ Test 2 Passed: CARD_NUMBER typing action -> risk_tier = "risky"');
}

// 3. Normal safe action -> risk_tier = "safe"
{
  const action = {
    type: 'click',
    target_element_id: 'nav-home-link',
    value: null
  };
  const riskTier = classifyActionRisk(action);
  assert.strictEqual(riskTier, 'safe', 'Normal action must have risk_tier = "safe"');
  assert.notStrictEqual(riskTier, 3, 'risk_tier MUST NOT be numeric 3');
  console.log('✔ Test 3 Passed: Normal safe action -> risk_tier = "safe"');
}

// 4. Semantic token [CARD_NUMBER_1] remains unchanged
{
  const vault = createTokenVault();
  const token = vault.getOrCreateToken('4111 1111 1111 1111', 'CARD_NUMBER');
  assert.strictEqual(token, '[CARD_NUMBER_1]', 'Semantic token format must remain [CARD_NUMBER_1]');
  console.log('✔ Test 4 Passed: Semantic token [CARD_NUMBER_1] remains unchanged');
}

// 5. assertSafeToSend() still blocks raw PII
{
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
  console.log('✔ Test 5 Passed: assertSafeToSend() still blocks raw PII');
}

// 6. No Token Vault behavior changes
{
  const sessionId = 'session-test-123';
  const vault = getVaultForSession(sessionId);
  const token = vault.getOrCreateToken('user@example.com', 'EMAIL');
  assert.strictEqual(token, '[EMAIL_1]');
  assert.strictEqual(vault.resolveToken('[EMAIL_1]'), 'user@example.com');

  endSession(sessionId);
  assert.strictEqual(vault.resolveToken('[EMAIL_1]'), null);
  console.log('✔ Test 6 Passed: No Token Vault behavior changes');
}

// 7. Verify numeric risk_tier conversion (legacy/mismatched payloads)
{
  const actionWithNumeric1 = { type: 'type', target_element_id: 'card-input', value: '[CARD_NUMBER_1]', risk_tier: 1 };
  assert.strictEqual(classifyActionRisk(actionWithNumeric1), 'risky');

  const actionWithNumeric3 = { type: 'click', target_element_id: 'btn-back', risk_tier: 3 };
  assert.strictEqual(classifyActionRisk(actionWithNumeric3), 'safe');

  console.log('✔ Test 7 Passed: Numeric risk_tier converted properly to string enum ("safe" | "risky")');
}

// 8. Specific validation of sensitivity_tier (1, 2, 3) & action risk_tier ("safe", "risky")
{
  // sensitivity_tier numeric validity checks
  const tier1Res = classifySensitivity({ sensitivity_type: 'CARD_NUMBER' }, []);
  assert.strictEqual(tier1Res.sensitivity_tier, 1, 'sensitivity_tier = 1 must be valid');

  const tier2Res = classifySensitivity({ sensitivity_type: 'EMAIL' }, []);
  assert.strictEqual(tier2Res.sensitivity_tier, 2, 'sensitivity_tier = 2 must be valid');

  const tier3Res = classifySensitivity({ sensitivity_type: 'UNKNOWN' }, []);
  assert.strictEqual(tier3Res.sensitivity_tier, 3, 'sensitivity_tier = 3 must be valid');

  // action risk_tier string enum validity checks
  const safeAction = { type: 'click', target_element_id: 'btn-home', risk_tier: 'safe' };
  assert.strictEqual(classifyActionRisk(safeAction), 'safe', 'action risk_tier = "safe" must be valid');

  const riskyAction = { type: 'type', target_element_id: 'card-input', risk_tier: 'risky' };
  assert.strictEqual(classifyActionRisk(riskyAction), 'risky', 'action risk_tier = "risky" must be valid');

  console.log('✔ Test 8 Passed: sensitivity_tier (1,2,3) & action risk_tier ("safe","risky") strictly validated');
}

console.log('\n--- ALL DEV 2 TESTS PASSED SUCCESSFULLY ---');

