import {
  createErrorResponse,
  MessageParseError,
  MESSAGE_TYPES,
  parseMessage,
} from "../src/shared/messages";
import { createRequestMeta } from "../src/shared/request-id";

function validPing(overrides: Record<string, unknown> = {}) {
  const ret: Record<string, unknown> = {
    type: MESSAGE_TYPES.PING,
    origin: "content-script",
    ...createRequestMeta(),
    ...overrides,
  };
  return ret;
}

describe("parseMessage", () => {
  it("accepts a valid PING", () => {
    const msg = parseMessage(validPing());
    expect(msg.type).toBe("PING");
  });

  it("accepts a valid OFFSCREEN_PING", () => {
    const msg = parseMessage({
      type: "OFFSCREEN_PING",
      origin: "background",
      ...createRequestMeta(),
    });
    expect(msg.type).toBe("OFFSCREEN_PING");
  });

  it.each(["", null, undefined, 42, "PING", [], {}])("rejects non-object %p", (v) => {
    expect(() => parseMessage(v)).toThrow(MessageParseError);
  });

  it("rejects unknown type", () => {
    expect(() => parseMessage({ ...validPing(), type: "NOPE" })).toThrow(/Unknown message type/);
  });

  it("rejects missing/invalid requestId", () => {
    expect(() => parseMessage(validPing({ requestId: undefined }))).toThrow(/requestId/);
    expect(() => parseMessage(validPing({ requestId: "" }))).toThrow(/requestId/);
    expect(() => parseMessage(validPing({ requestId: 12 }))).toThrow(/requestId/);
  });

  it("rejects missing/invalid timestamp", () => {
    expect(() => parseMessage(validPing({ timestamp: undefined }))).toThrow(/timestamp/);
    expect(() => parseMessage(validPing({ timestamp: NaN }))).toThrow(/timestamp/);
  });

  it("rejects invalid origin", () => {
    expect(() => parseMessage(validPing({ origin: "nobody" }))).toThrow(/origin/);
    expect(() => parseMessage(validPing({ origin: undefined }))).toThrow(/origin/);
  });

  it("accepts all declared placeholder types (future phases)", () => {
    const types = [
      "DOM_CAPTURE_REQUEST",
      "DOM_CAPTURE_RESULT",
      "SCREENSHOT_REQUEST",
      "SCREENSHOT_RESULT",
      "ANALYSIS_REQUEST",
      "ANALYSIS_RESULT",
      "MUTATION_DETECTED",
      "INVALIDATE_CACHE",
    ];
    for (const type of types) {
      const msg = parseMessage({ type, origin: "content-script", ...createRequestMeta() });
      expect(msg.type).toBe(type);
    }
  });

  it("exposes every valid type through MESSAGE_TYPES", () => {
    // No stray string literals: every member must be parseable.
    for (const type of Object.values(MESSAGE_TYPES)) {
      const msg = parseMessage({ type, origin: "background", ...createRequestMeta() });
      expect(msg.type).toBe(type);
    }
  });
});

describe("createErrorResponse", () => {
  it("echoes requestId when the input carried one", () => {
    const input = validPing();
    const err = createErrorResponse(input, new Error("boom"), "background");
    expect(err.type).toBe("ERROR_RESPONSE");
    expect(err.ok).toBe(false);
    expect(err.requestId).toBe(input.requestId);
    expect(err.error).toBe("boom");
    expect(err.origin).toBe("background");
  });

  it("falls back to a safe requestId when input is unscannable", () => {
    const err = createErrorResponse(42, "nope", "background");
    expect(err.requestId).toBe("unknown");
  });
});