export class SearchCanceledException extends Error {
  constructor() {
    super('SearchCanceledException');
    this.name = 'SearchCanceledException';
  }
}

export class CancellationToken {
  private canceled = false;
  private readonly callbacks: (() => void)[] = [];

  get isCanceled(): boolean {
    return this.canceled;
  }

  onCancel(callback: () => void): void {
    if (this.canceled) {
      callback();
      return;
    }
    this.callbacks.push(callback);
  }

  throwIfCanceled(): void {
    if (this.canceled) throw new SearchCanceledException();
  }

  cancel(): void {
    if (this.canceled) return;
    this.canceled = true;
    const callbacks = this.callbacks.splice(0, this.callbacks.length);
    for (const callback of callbacks) {
      callback();
    }
  }
}
