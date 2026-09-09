/**
 * Offscreen Document lifecycle management (idempotent, testable).
 *
 * The Service Worker calls `ensureOffscreenDocument()` before any inference
 * work. It is safe to call repeatedly: it inspects live extension contexts
 * (Chrome 116+) and only calls `chrome.offscreen.createDocument` when no
 * OFFSCREEN_DOCUMENT context exists, so service worker restarts never create
 * duplicates.
 *
 * Chrome APIs are injected via `deps` so the decision logic and the
 * create-document behavior are unit-testable without the browser.
 */

import {
  OFFSCREEN_JUSTIFICATION,
  OFFSCREEN_REASON,
  OFFSCREEN_URL,
} from "./constants";

export const OFFSCREEN_CONTEXT_TYPE = "OFFSCREEN_DOCUMENT";

export type ChromeOffscreenContextType =
  | "TAB"
  | "POPUP"
  | "BACKGROUND"
  | "OFFSCREEN_DOCUMENT"
  | "SIDE_PANEL"
  | "DEVELOPER_TOOLS";

export type OffscreenReason = typeof OFFSCREEN_REASON;

export interface OffscreenContextEntry {
  contextType: ChromeOffscreenContextType;
  documentUrl?: string;
  incognito?: boolean;
}

export interface OffscreenDocumentOutcome {
  /** True when this call created a new offscreen document. */
  created: boolean;
  /** True when an offscreen document exists after the call. */
  present: boolean;
  /** Known offscreen document URL(s), if reported by the runtime. */
  documentUrls: string[];
}

export interface OffscreenDeps {
  getContexts(filter: {
    contextTypes: ChromeOffscreenContextType[];
  }): Promise<OffscreenContextEntry[]>;
  createDocument(createProperties: {
    url: string;
    reasons: OffscreenReason[];
    justification: string;
  }): Promise<void>;
  getURL(path: string): string;
}

function defaultDeps(): OffscreenDeps {
  const chromeApi = (globalThis as { chrome?: typeof chrome }).chrome;
  if (!chromeApi || typeof chromeApi.runtime?.getContexts !== "function") {
    throw new Error("chrome.runtime.getContexts is unavailable (Chrome < 116)");
  }
  if (typeof chromeApi.offscreen?.createDocument !== "function") {
    throw new Error("chrome.offscreen.createDocument is unavailable");
  }
  return {
    getContexts: (filter) =>
      chromeApi.runtime
        .getContexts(filter as chrome.runtime.ContextFilter)
        .then((entries) =>
          entries.map((e) => ({
            contextType: e.contextType as ChromeOffscreenContextType,
            documentUrl: e.documentUrl,
            incognito: e.incognito,
          }))
        ),
    createDocument: (props) =>
      chromeApi.offscreen.createDocument(props as chrome.offscreen.CreateParameters),
    getURL: (path) => chromeApi.runtime.getURL(path),
  };
}

/** Pure decision: should we create a new offscreen document right now? */
export function shouldCreateOffscreenDocument(
  entries: readonly OffscreenContextEntry[]
): boolean {
  return !entries.some((e) => e.contextType === OFFSCREEN_CONTEXT_TYPE);
}

/**
 * Ensure an offscreen document exists, creating one if and only if none does.
 * Idempotent across service worker restarts.
 */
export async function ensureOffscreenDocument(deps: OffscreenDeps = defaultDeps()): Promise<
  OffscreenDocumentOutcome
> {
  const filter = { contextTypes: [OFFSCREEN_CONTEXT_TYPE] as ChromeOffscreenContextType[] };
  const before = await deps.getContexts(filter);
  const needed = shouldCreateOffscreenDocument(before);

  let created = false;
  if (needed) {
    await deps.createDocument({
      url: deps.getURL(OFFSCREEN_URL),
      reasons: [OFFSCREEN_REASON],
      justification: OFFSCREEN_JUSTIFICATION,
    });
    created = true;
  }

  // Re-read after (possibly) creating to report ground truth.
  const after = await deps.getContexts(filter);
  const present = shouldCreateOffscreenDocument(after) === false;
  const documentUrls = after
    .filter((e) => e.contextType === OFFSCREEN_CONTEXT_TYPE)
    .map((e) => e.documentUrl ?? OFFSCREEN_URL);

  return { created, present, documentUrls };
}