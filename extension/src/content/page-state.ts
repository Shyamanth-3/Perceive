/**
 * Page-state capture helper for the content script: viewport, devicePixelRatio,
 * and scroll position captured at a fixed instant (aligns DOM + screenshot
 * coordinate spaces; plan §4.3 / Phase 2 §2.4).
 */

export interface ViewportLike {
  width: number;
  height: number;
}

export interface ScrollLike {
  x: number;
  y: number;
}

export interface PageState {
  domCapturedAt: number;
  viewport: ViewportLike;
  devicePixelRatio: number;
  scroll: ScrollLike;
  documentTitle: string;
  url: string;
}

/** Read the current page state once. All numbers are captured in a single tick. */
export function capturePageStateNow(now: () => number = Date.now): PageState {
  return {
    domCapturedAt: now(),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
    devicePixelRatio: window.devicePixelRatio,
    scroll: {
      x: window.scrollX,
      y: window.scrollY,
    },
    documentTitle: document.title,
    url: location.href,
  };
}

/** Adapt explicit options (used by tests) to a full PageState. */
export function captureFromDocumentState(state?: Partial<PageState>, now: () => number = Date.now): PageState {
  const base = typeof window !== "undefined" ? capturePageStateNow(now) : {
    domCapturedAt: now(),
    viewport: { width: 1280, height: 720 },
    devicePixelRatio: 1,
    scroll: { x: 0, y: 0 },
    documentTitle: "",
    url: "",
  };
  return { ...base, ...state };
}