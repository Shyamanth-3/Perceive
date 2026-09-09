import {
  createRequestId,
  createRequestMeta,
  isRequestMeta,
} from "../src/shared/request-id";

describe("createRequestId", () => {
  it("returns unique ids", () => {
    const ids = new Set(Array.from({ length: 500 }, () => createRequestId()));
    expect(ids.size).toBe(500);
  });

  it("returns string ids of reasonable length", () => {
    const id = createRequestId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(8);
  });
});

describe("createRequestMeta", () => {
  it("carries requestId + timestamp", () => {
    const before = Date.now();
    const meta = createRequestMeta();
    const after = Date.now();
    expect(meta.requestId.length).toBeGreaterThan(0);
    expect(meta.timestamp).toBeGreaterThanOrEqual(before);
    expect(meta.timestamp).toBeLessThanOrEqual(after);
  });
});

describe("isRequestMeta", () => {
  it("accepts valid meta", () => {
    expect(isRequestMeta(createRequestMeta())).toBe(true);
  });

  it("rejects malformed values", () => {
    expect(isRequestMeta(null)).toBe(false);
    expect(isRequestMeta(undefined)).toBe(false);
    expect(isRequestMeta({})).toBe(false);
    expect(isRequestMeta({ requestId: "" })).toBe(false);
    expect(isRequestMeta({ requestId: "x", timestamp: NaN })).toBe(false);
    expect(isRequestMeta({ requestId: 42, timestamp: 1 })).toBe(false);
    expect(isRequestMeta("PING")).toBe(false);
  });
});