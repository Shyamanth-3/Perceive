/**
 * Dev 5 — demo/status panel + client-side audit log.
 *
 * Consumes ONLY real runtime state: the pipeline-stage events Dev 4's
 * orchestrator emits at its real transitions (`dev5-events.ts`) and the
 * real `agent-session-end` event `finalizeTask` already dispatches. It does
 * not call into Dev 1/2/3/4 itself, does not create any second pipeline, and
 * never fabricates a status.
 *
 * Privacy: every field this panel ever renders comes from
 * `PipelineEventDetail`, which structurally cannot carry a raw sensitive
 * value (see dev5-events.ts) — action `value` is never even accepted by
 * that type. Only `actionType`/`targetElementId`/`riskTier`/counts/reasons
 * are shown, matching the "EMAIL -> [EMAIL_1], never the real value" rule.
 *
 * The panel's own root carries `data-perceive-ui="true"` so Dev 1's capture
 * walker (shared/capture.ts) skips it entirely — it must never become part
 * of what the LLM sees, and must never affect element_id numbering.
 */

import { PIPELINE_EVENT_NAME, type PipelineEventDetail } from "./dev5-events";
import { PERCEIVE_UI_MARKER_ATTR } from "../shared/constants";

const PANEL_ROOT_ID = "perceive-dev5-panel";
const MAX_AUDIT_ENTRIES = 30;

const STAGE_LABELS: Record<string, string> = {
  CAPTURING: "Capturing page",
  SANITIZING: "Classifying & tokenizing",
  SENSITIVE_DATA_DETECTED: "Sensitive data detected",
  SENDING_SANITIZED_REQUEST: "Sending sanitized request",
  WAITING_FOR_LLM: "Waiting for LLM",
  ACTION_RECEIVED: "Action received",
  CONFIRMATION_REQUIRED: "Confirmation required",
  EXECUTING: "Executing action",
  COMPLETED: "Task complete",
  FAILED: "Failed",
};

function formatEvent(detail: PipelineEventDetail): string {
  const parts: string[] = [];
  if (detail.stepNumber != null) parts.push(`step ${detail.stepNumber}`);
  if (detail.sensitiveElementCount != null) parts.push(`${detail.sensitiveElementCount} sensitive field(s)`);
  if (detail.actionType) parts.push(`action=${detail.actionType}`);
  if (detail.targetElementId) parts.push(`target=${detail.targetElementId}`);
  if (detail.riskTier) parts.push(`risk=${detail.riskTier}`);
  if (detail.approved != null) parts.push(detail.approved ? "user allowed" : "user denied");
  if (detail.reason) parts.push(`reason=${detail.reason}`);
  return parts.join(" · ");
}

export function mountDev5Panel(): void {
  if (document.getElementById(PANEL_ROOT_ID)) return; // idempotent

  const root = document.createElement("div");
  root.id = PANEL_ROOT_ID;
  root.setAttribute(PERCEIVE_UI_MARKER_ATTR, "true");
  Object.assign(root.style, {
    position: "fixed",
    bottom: "12px",
    right: "12px",
    width: "300px",
    maxHeight: "40vh",
    background: "rgba(20, 22, 26, 0.92)",
    color: "#e8e8e8",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "11px",
    borderRadius: "8px",
    boxShadow: "0 2px 10px rgba(0,0,0,0.35)",
    zIndex: "999998", // just under the confirmation overlay (999999)
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  });

  const header = document.createElement("div");
  header.setAttribute(PERCEIVE_UI_MARKER_ATTR, "true");
  Object.assign(header.style, {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "6px 10px",
    background: "rgba(255,255,255,0.06)",
    cursor: "pointer",
  });
  header.textContent = "🔒 Perceive — privacy status";

  const toggleBtn = document.createElement("span");
  toggleBtn.textContent = "▾";
  toggleBtn.style.marginLeft = "8px";
  header.appendChild(toggleBtn);

  const body = document.createElement("div");
  body.setAttribute(PERCEIVE_UI_MARKER_ATTR, "true");
  Object.assign(body.style, { padding: "8px 10px", overflowY: "auto" });

  const statusLine = document.createElement("div");
  statusLine.id = "perceive-dev5-status";
  Object.assign(statusLine.style, { fontWeight: "bold", marginBottom: "6px" });
  statusLine.textContent = "Idle — no task running";

  const auditList = document.createElement("div");
  auditList.id = "perceive-dev5-audit";
  Object.assign(auditList.style, { display: "flex", flexDirection: "column", gap: "2px" });

  body.appendChild(statusLine);
  body.appendChild(auditList);
  root.appendChild(header);
  root.appendChild(body);
  document.body.appendChild(root);

  let collapsed = false;
  header.addEventListener("click", () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? "none" : "block";
    toggleBtn.textContent = collapsed ? "▸" : "▾";
  });

  const entries: string[] = [];
  function pushAuditEntry(text: string): void {
    entries.push(text);
    while (entries.length > MAX_AUDIT_ENTRIES) entries.shift();
    auditList.textContent = "";
    for (const line of entries.slice().reverse()) {
      const row = document.createElement("div");
      row.textContent = line;
      row.style.opacity = "0.85";
      auditList.appendChild(row);
    }
  }

  window.addEventListener(PIPELINE_EVENT_NAME, ((ev: CustomEvent<PipelineEventDetail>) => {
    const detail = ev.detail;
    const label = STAGE_LABELS[detail.stage] ?? detail.stage;
    statusLine.textContent = label;
    statusLine.style.color = detail.stage === "FAILED" ? "#ff6b6b" : detail.stage === "COMPLETED" ? "#51cf66" : "#e8e8e8";
    const time = new Date(detail.ts).toLocaleTimeString();
    pushAuditEntry(`[${time}] ${label}${formatEvent(detail) ? " — " + formatEvent(detail) : ""}`);
  }) as EventListener);

  window.addEventListener("agent-session-end", ((ev: CustomEvent<{ sessionId: string; reason: string }>) => {
    const { reason } = ev.detail;
    pushAuditEntry(`[session end] reason=${reason}`);
  }) as EventListener);
}
