/**
 * Minimal Dev 2 → Dev 3 network transport, scoped ONLY to verifying this
 * integration boundary. This is deliberately NOT Dev 4's `transport.js`
 * (mocks, retry/backoff policy, risk-tier gating before send, etc. are all
 * Dev 4's owned responsibility, out of scope here per the integration
 * instructions) — just a real `fetch()` proving a real sanitized payload
 * reaches a real backend and a real structured response comes back.
 */

import type { ClientPayload } from "../content/dev2-payload";

export interface ServerActionResponse {
  session_id: string;
  step_number: number;
  action: {
    type: string;
    target_element_id: string | null;
    value: string | null;
    risk_tier: "safe" | "risky";
    reasoning_short: string;
  };
  confidence: number;
}

const BACKEND_URL = "http://127.0.0.1:8000";

export async function sendToBackend(payload: ClientPayload): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${BACKEND_URL}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}
