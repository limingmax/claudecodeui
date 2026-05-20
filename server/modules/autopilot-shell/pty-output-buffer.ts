export class PtyOutputBuffer {
  private buf = '';

  constructor(
    private readonly stripAnsi: (s: string) => string,
    private readonly maxLen = 32768,
  ) {}

  push(chunk: string): void {
    this.buf += this.stripAnsi(chunk);
    if (this.buf.length > this.maxLen) {
      this.buf = this.buf.slice(-this.maxLen);
    }
  }

  drain(): string {
    const out = this.buf;
    this.buf = '';
    return out;
  }

  peek(): string {
    return this.buf;
  }
}
