/** An async-iterable queue: producers push, one consumer pulls with `next()`. */
export class EventQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private items: T[] = [];
  private waiting: Array<(r: IteratorResult<T>) => void> = [];
  private done = false;

  push(item: T) {
    if (this.done) return;
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  end() {
    this.done = true;
    for (const w of this.waiting.splice(0)) w({ value: undefined as any, done: true });
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
    if (this.done) return Promise.resolve({ value: undefined as any, done: true });
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  [Symbol.asyncIterator]() {
    return this;
  }
}
