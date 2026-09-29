/** Minimal behaviour tree: selectors, sequences, conditions and (stateful) actions. */

export type Status = 'success' | 'failure' | 'running';

export interface BTNode<C> {
  tick(ctx: C, dt: number): Status;
  /** Called when a running branch is abandoned. */
  reset?(ctx: C): void;
  readonly name?: string;
}

/** First child that doesn't fail wins; aborts a previously running child when a higher one takes over. */
export class Selector<C> implements BTNode<C> {
  private running = -1;
  constructor(private children: BTNode<C>[], readonly name = 'selector') {}
  tick(ctx: C, dt: number): Status {
    for (let i = 0; i < this.children.length; i++) {
      const s = this.children[i].tick(ctx, dt);
      if (s !== 'failure') {
        if (this.running !== -1 && this.running !== i) this.children[this.running].reset?.(ctx);
        this.running = s === 'running' ? i : -1;
        return s;
      }
    }
    if (this.running !== -1) this.children[this.running].reset?.(ctx);
    this.running = -1;
    return 'failure';
  }
  reset(ctx: C): void {
    if (this.running !== -1) this.children[this.running].reset?.(ctx);
    this.running = -1;
  }
}

/** All children must succeed in order. */
export class Sequence<C> implements BTNode<C> {
  constructor(private children: BTNode<C>[], readonly name = 'sequence') {}
  tick(ctx: C, dt: number): Status {
    for (const c of this.children) {
      const s = c.tick(ctx, dt);
      if (s !== 'success') return s;
    }
    return 'success';
  }
  reset(ctx: C): void {
    for (const c of this.children) c.reset?.(ctx);
  }
}

export class Condition<C> implements BTNode<C> {
  constructor(private fn: (ctx: C) => boolean, readonly name = 'cond') {}
  tick(ctx: C): Status {
    return this.fn(ctx) ? 'success' : 'failure';
  }
}

export class Action<C> implements BTNode<C> {
  constructor(
    private fn: (ctx: C, dt: number) => Status,
    private onReset?: (ctx: C) => void,
    readonly name = 'action',
  ) {}
  tick(ctx: C, dt: number): Status {
    return this.fn(ctx, dt);
  }
  reset(ctx: C): void {
    this.onReset?.(ctx);
  }
}
