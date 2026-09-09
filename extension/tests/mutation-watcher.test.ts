/**
 * Phase 3 unit tests for content/mutation-watcher.ts — the 250 ms debounce
 * that collapses mutation bursts into one capture trigger.
 */

import { MutationWatcher, type Scheduler } from "../src/content/mutation-watcher";
import { MUTATION_DEBOUNCE_MS } from "../src/shared/constants";

class FakeScheduler implements Scheduler {
  fires: (() => void)[] = [];
  setCalls = 0;
  clearCalls = 0;

  setTimeout(cb: () => void) {
    this.fires.push(cb);
    this.setCalls += 1;
    return this.setCalls;
  }

  clearTimeout() {
    this.clearCalls += 1;
  }

  /** Fire the currently scheduled debounce callback (advance the window). */
  advance(): void {
    const cb = this.fires.shift();
    if (cb) cb();
  }
}

describe("MutationWatcher", () => {
  it("merges a burst of mutations into a single trigger with the total count", () => {
    const scheduler = new FakeScheduler();
    const fires: number[] = [];
    const watcher = new MutationWatcher({
      debounceMs: MUTATION_DEBOUNCE_MS,
      onDebounced: (count) => fires.push(count),
      scheduler,
    });

    watcher.recordMutations(3);
    watcher.recordMutations(2);
    watcher.recordMutations(4);
    expect(scheduler.setCalls).toBe(1); // one timer for the whole burst
    expect(fires).toEqual([]);

    scheduler.advance();
    expect(fires).toEqual([9]);
  });

  it("starts a fresh window after a fire", () => {
    const scheduler = new FakeScheduler();
    const fires: number[] = [];
    const watcher = new MutationWatcher({
      debounceMs: MUTATION_DEBOUNCE_MS,
      onDebounced: (count) => fires.push(count),
      scheduler,
    });

    watcher.recordMutations(1);
    scheduler.advance();
    watcher.recordMutations(5);
    scheduler.advance();
    expect(fires).toEqual([1, 5]);
    expect(scheduler.setCalls).toBe(2);
  });

  it("flush() emits pending counts immediately", () => {
    const scheduler = new FakeScheduler();
    let fired = 0;
    const watcher = new MutationWatcher({
      debounceMs: MUTATION_DEBOUNCE_MS,
      onDebounced: (c) => {
        fired = c;
      },
      scheduler,
    });
    watcher.recordMutations(7);
    watcher.flush();
    expect(fired).toBe(7);
    expect(scheduler.clearCalls).toBe(1);
  });

  it("disconnect() cancels the timer and drops pending counts", () => {
    const scheduler = new FakeScheduler();
    let fired = 0;
    const watcher = new MutationWatcher({
      debounceMs: MUTATION_DEBOUNCE_MS,
      onDebounced: () => {
        fired += 1;
      },
      scheduler,
    });
    watcher.recordMutations(2);
    watcher.disconnect();
    scheduler.advance(); // stale callback must not fire after disconnect
    expect(fired).toBe(0);
    expect(scheduler.clearCalls).toBe(1);
  });

  it("ignores zero/negative counts", () => {
    const scheduler = new FakeScheduler();
    let fired = 0;
    const watcher = new MutationWatcher({
      debounceMs: MUTATION_DEBOUNCE_MS,
      onDebounced: () => {
        fired += 1;
      },
      scheduler,
    });
    watcher.recordMutations(0);
    watcher.recordMutations(-1);
    expect(scheduler.setCalls).toBe(0);
    expect(fired).toBe(0);
  });
});