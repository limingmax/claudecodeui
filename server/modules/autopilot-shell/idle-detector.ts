export class PtyIdleDetector {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly idleMs: number,
    private readonly onIdle: () => void,
  ) {}

  notifyChunk(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onIdle();
    }, this.idleMs);
  }

  pause(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.pause();
  }
}
