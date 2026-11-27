interface Frame {
  rows: string[];
  row: number;
  column: number;
  width: number;
  height: number;
}

const csi = '\x1b[';

function synchronized(output: string): string {
  return output ? csi + '?2026h' + output + csi + '?2026l' : '';
}

function vertical(distance: number): string {
  return distance === 0 ? '' : csi + Math.abs(distance) + (distance < 0 ? 'A' : 'B');
}

export class Footer {
  private frame?: Frame;

  render(next: Frame, transcript = ''): string {
    let previous = this.frame;
    let output = '';
    if (
      transcript ||
      (previous && (previous.width !== next.width || previous.height !== next.height))
    ) {
      output = this.clear() + transcript;
      previous = undefined;
    }

    let row = previous?.row ?? 0;
    let column = previous?.column ?? 0;
    function move(target: number, targetColumn = 0): void {
      output += vertical(target - row);
      row = target;
      if (column === targetColumn) return;
      output += '\r' + (targetColumn ? csi + targetColumn + 'C' : '');
      column = targetColumn;
    }

    const oldRows = previous?.rows ?? [];
    for (let index = 0; index < Math.max(oldRows.length, next.rows.length); index += 1) {
      const line = next.rows[index];
      if (line === oldRows[index]) continue;
      if (index >= oldRows.length && index > 0) {
        move(index - 1);
        output += '\r\n';
        row = index;
      } else {
        move(index);
      }
      output += (line ?? '') + csi + 'K\r';
    }
    move(next.row, next.column);
    this.frame = next;
    return synchronized(output);
  }

  close(transcript: string): string {
    return synchronized(this.clear() + transcript);
  }

  private clear(): string {
    const previous = this.frame;
    this.frame = undefined;
    return previous ? '\r' + vertical(-previous.row) + csi + 'J' : '';
  }
}
