/**
 * Mutation debouncer (Phase 3, plan §5.1): collapses bursts of DOM mutations
 * into a single trigger after `debounceMs`. Pure and injectable so Jest can
 * drive time without a real MutationObserver. The content script wires real
 * observer records into `recordMutations`.
 */

export interface Scheduler {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const defaultScheduler: Scheduler = {
  setTimeout(cb, ms) {
    return setTimeout(cb, ms);
  },
  clearTimeout(id) {
    clearTimeout(id as ReturnType<typeof setTimeout>);
  },
};

export interface MutationWatcherOptions {
  debounceMs: number;
  /** Fired once per debounce window with the total record count inside it. */
  onDebounced: (mutationCount: number) => void;
  scheduler?: Scheduler;
}

export class MutationWatcher {
  private pending = 0;
  private timerActive = false;
  private scheduled: unknown = null;
  private readonly scheduler: Scheduler;

  constructor(private readonly options: MutationWatcherOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  /** Merge `count` new records into the current debounce window. */
  recordMutations(count: number): void {
    if (count <= 0) return;
    this.pending += count;
    if (!this.timerActive) {
      this.timerActive = true;
      this.scheduled = this.scheduler.setTimeout(() => this.fire(), this.options.debounceMs);
    }
  }

  /** Immediately emit whatever is pending and cancel the timer. */
  flush(): void {
    if (this.timerActive) {
      this.scheduler.clearTimeout(this.scheduled);
      this.fire();
    }
  }

  /** Cancel pending work and drop accumulated counts. */
  disconnect(): void {
    if (this.timerActive) {
      this.scheduler.clearTimeout(this.scheduled);
    }
    this.timerActive = false;
    this.scheduled = null;
    this.pending = 0;
  }

  private fire(): void {
    this.timerActive = false;
    this.scheduled = null;
    const count = this.pending;
    this.pending = 0;
    if (count > 0) this.options.onDebounced(count);
  }
}