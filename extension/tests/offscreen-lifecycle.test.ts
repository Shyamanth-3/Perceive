import {
  ensureOffscreenDocument,
  shouldCreateOffscreenDocument,
  type ChromeOffscreenContextType,
  type OffscreenContextEntry,
  type OffscreenDeps,
} from "../src/shared/offscreen-lifecycle";

const OFF_URL = "chrome-extension://x/offscreen/offscreen.html";

function asEntry(context: ChromeOffscreenContextType, documentUrl?: string): OffscreenContextEntry {
  return documentUrl ? { contextType: context, documentUrl } : { contextType: context };
}

function makeDeps(overrides: Partial<OffscreenDeps> = {}): OffscreenDeps {
  const boxes: OffscreenContextEntry[] = [];
  return {
    getContexts: overrides.getContexts ?? (() => Promise.resolve([...boxes])),
    createDocument: overrides.createDocument ?? (async () => {
      boxes.push(asEntry("OFFSCREEN_DOCUMENT", OFF_URL));
    }),
    getURL: overrides.getURL ?? ((p: string) => `chrome-extension://x/${p}`),
  };
}

describe("shouldCreateOffscreenDocument (pure decision)", () => {
  it("returns true when no offscreen context exists", () => {
    expect(shouldCreateOffscreenDocument([])).toBe(true);
    expect(shouldCreateOffscreenDocument([asEntry("TAB")])).toBe(true);
  });

  it("returns false when an OFFSCREEN_DOCUMENT exists", () => {
    expect(shouldCreateOffscreenDocument([asEntry("OFFSCREEN_DOCUMENT", OFF_URL)])).toBe(false);
    expect(
      shouldCreateOffscreenDocument([asEntry("TAB"), asEntry("OFFSCREEN_DOCUMENT", OFF_URL)])
    ).toBe(false);
  });

  it("does not confuse other context types with offscreen", () => {
    const others: ChromeOffscreenContextType[] = ["TAB", "POPUP", "SIDE_PANEL", "DEVELOPER_TOOLS"];
    for (const context of others) {
      expect(shouldCreateOffscreenDocument([asEntry(context)])).toBe(true);
    }
  });
});

describe("ensureOffscreenDocument (idempotency)", () => {
  it("creates when none exists, reports created=true, present=true", async () => {
    const deps = makeDeps();
    const out = await ensureOffscreenDocument(deps);
    expect(out.created).toBe(true);
    expect(out.present).toBe(true);
    expect(out.documentUrls).toContain(OFF_URL);
  });

  it("does NOT create a second document when one already exists", async () => {
    const createDocument = jest.fn();
    const deps = makeDeps({ createDocument });
    deps.getContexts = () => Promise.resolve([asEntry("OFFSCREEN_DOCUMENT", OFF_URL)]);
    const out1 = await ensureOffscreenDocument(deps);
    const out2 = await ensureOffscreenDocument(deps);
    expect(createDocument).not.toHaveBeenCalled();
    expect(out1.created).toBe(false);
    expect(out1.present).toBe(true);
    expect(out2.created).toBe(false);
    expect(out2.present).toBe(true);
  });

  it("is idempotent across repeated calls: exactly one createDocument call", async () => {
    const createDocument = jest.fn();
    const state: OffscreenContextEntry[] = [];
    const deps = makeDeps();
    deps.getContexts = () => Promise.resolve([...state]);
    deps.createDocument = async (props) => {
      createDocument(props);
      state.push(asEntry("OFFSCREEN_DOCUMENT", OFF_URL));
    };
    const r1 = await ensureOffscreenDocument(deps);
    const r2 = await ensureOffscreenDocument(deps);
    const r3 = await ensureOffscreenDocument(deps);
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r3.created).toBe(false);
    expect(createDocument).toHaveBeenCalledTimes(1);
    const [props] = createDocument.mock.calls[0] ?? [undefined];
    expect(props).toMatchObject({
      url: "chrome-extension://x/offscreen/offscreen.html",
      reasons: ["WORKERS"],
      justification: expect.stringContaining("Web-Worker"),
    });
  });

  it("propagates the WORKERS reason (never arbitrary reasons)", async () => {
    const createDocument = jest.fn();
    const state: OffscreenContextEntry[] = [];
    const deps = makeDeps();
    deps.getContexts = () => Promise.resolve([...state]);
    deps.createDocument = async (props) => {
      createDocument(props);
      state.push(asEntry("OFFSCREEN_DOCUMENT"));
    };
    await ensureOffscreenDocument(deps);
    const [props] = createDocument.mock.calls[0] ?? [undefined];
    expect(props?.reasons).toEqual(["WORKERS"]);
  });

  it("returns documentUrls from the live context list", async () => {
    const deps = makeDeps();
    const out = await ensureOffscreenDocument(deps);
    expect(Array.isArray(out.documentUrls)).toBe(true);
    expect(out.documentUrls.length).toBeGreaterThan(0);
  });
});