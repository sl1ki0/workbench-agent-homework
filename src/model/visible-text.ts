import type { ModelObserver } from './protocol.js';

const beginThinking = '<think>';
const endThinking = '</think>';

/** Some compatible providers put thinking delimiters in content instead of using reasoning fields. */
export class VisibleText {
  private buffer = '';
  private content = '';
  private hiding = false;
  private thinkingSeen = false;

  constructor(
    private readonly observe?: ModelObserver,
    private awaitingBoundary = false,
  ) {}

  structuredThinking(): void {
    if (this.awaitingBoundary && !this.buffer.trim()) this.awaitingBoundary = false;
    this.markThinking();
  }

  markThinking(): void {
    if (this.thinkingSeen) return;
    this.thinkingSeen = true;
    this.observe?.({ type: 'thinking' });
  }

  add(part: string): void {
    this.buffer += part;
    // Local Qwen templates can put the opening marker in the prompt, so only the
    // closing marker arrives over the wire. Hold the prefix until the boundary.
    if (this.awaitingBoundary) {
      const boundary = /<think>|<\/think>/iu.exec(this.buffer);
      if (!boundary) return;
      const marker = boundary[0];
      this.buffer = this.buffer.slice(boundary.index + marker.length);
      this.awaitingBoundary = false;
      this.hiding = marker.toLowerCase() === beginThinking;
      this.markThinking();
    }
    for (;;) {
      const marker = this.hiding ? endThinking : beginThinking;
      const boundary = this.buffer.search(this.hiding ? /<\/think>/iu : /<think>/iu);
      if (boundary < 0) {
        // Keep only the suffix that could be the beginning of a delimiter in the next chunk.
        const lower = this.buffer.toLowerCase();
        let retained = Math.min(marker.length - 1, this.buffer.length);
        while (retained > 0 && !lower.endsWith(marker.slice(0, retained))) retained--;
        this.take(this.buffer.length - retained);
        return;
      }
      this.take(boundary);
      this.buffer = this.buffer.slice(marker.length);
      this.hiding = !this.hiding;
      if (this.hiding) this.markThinking();
    }
  }

  finish(keepUnmarked = true): string | null {
    if (this.awaitingBoundary && !keepUnmarked) this.buffer = '';
    this.take(this.buffer.length);
    return this.content || null;
  }

  private take(count: number): void {
    const part = this.buffer.slice(0, count);
    this.buffer = this.buffer.slice(count);
    if (this.hiding || !part) return;
    this.content += part;
    this.observe?.({ type: 'text', text: part });
  }
}
