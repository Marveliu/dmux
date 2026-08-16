import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/**
 * Sidebar mouse support.
 *
 * The control pane enables terminal mouse reporting (SGR press/release only —
 * deliberately not motion tracking, which floods stdin) so clicks inside the
 * sidebar can move the selection highlight without touching tmux pane focus.
 *
 * Ink must never see the raw mouse escape sequences (they would leak into
 * text inputs as garbage), so dmux hands Ink a proxy stdin stream that strips
 * mouse sequences and re-emits them as structured events.
 */

export interface SidebarMouseEvent {
  type: 'press' | 'release';
  /** Button with modifier bits (shift/meta/ctrl) stripped: 0 left, 1 middle, 2 right, 64/65 wheel. */
  button: number;
  /** 1-based column, relative to the pane. */
  col: number;
  /** 1-based row, relative to the pane. */
  row: number;
}

export interface SidebarMouseEventSource {
  on(event: 'mouse', listener: (mouseEvent: SidebarMouseEvent) => void): unknown;
  off(event: 'mouse', listener: (mouseEvent: SidebarMouseEvent) => void): unknown;
}

export interface MouseFilteredStdin {
  /** Stream to hand to Ink's render() in place of process.stdin. */
  stdin: NodeJS.ReadStream;
  events: SidebarMouseEventSource;
  detach: () => void;
}

export interface MouseFilterResult {
  /** Input with mouse sequences removed. */
  output: string;
  events: SidebarMouseEvent[];
  /** Trailing bytes that look like the start of a mouse sequence, held for the next chunk. */
  carry: string;
}

// Press/release tracking + SGR extended coordinates.
export const MOUSE_REPORTING_ENABLE = '\x1b[?1000h\x1b[?1006h';
export const MOUSE_REPORTING_DISABLE = '\x1b[?1006l\x1b[?1000l';

export const MOUSE_LEFT_BUTTON = 0;
export const MOUSE_WHEEL_UP_BUTTON = 64;
export const MOUSE_WHEEL_DOWN_BUTTON = 65;

const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
// Legacy X10 encoding (ESC [ M + 3 coordinate bytes). dmux requests SGR, but
// strip these defensively so they can never reach Ink as keystrokes.
const X10_MOUSE_RE = /\x1b\[M[\s\S]{3}/g;
// Unambiguous prefix of an SGR mouse sequence split across chunks. A bare ESC
// or ESC[ is NOT held back — that would delay real escape/arrow keys.
const PARTIAL_SGR_TAIL_RE = /\x1b\[<[\d;]*$/;
const MAX_CARRY_LENGTH = 24;

const MODIFIER_BITS = 4 | 8 | 16; // shift, meta, ctrl

export const DOUBLE_CLICK_INTERVAL_MS = 400;

/**
 * Returns a function that reports whether a click on `index` at `now`
 * completes a double-click (two clicks on the same item within the interval).
 */
export function createDoubleClickTracker(
  intervalMs: number = DOUBLE_CLICK_INTERVAL_MS
): (index: number, now: number) => boolean {
  let last: { index: number; time: number } | null = null;

  return (index: number, now: number): boolean => {
    const isDoubleClick =
      !!last && last.index === index && now - last.time <= intervalMs;
    // A completed double-click resets the tracker so a triple click doesn't
    // fire twice; otherwise this click starts a new potential pair.
    last = isDoubleClick ? null : { index, time: now };
    return isDoubleClick;
  };
}

export function extractMouseSequences(input: string): MouseFilterResult {
  const events: SidebarMouseEvent[] = [];

  let output = input.replace(
    SGR_MOUSE_RE,
    (_match, buttonText: string, colText: string, rowText: string, kind: string) => {
      events.push({
        type: kind === 'M' ? 'press' : 'release',
        button: Number(buttonText) & ~MODIFIER_BITS,
        col: Number(colText),
        row: Number(rowText),
      });
      return '';
    }
  );
  output = output.replace(X10_MOUSE_RE, '');

  let carry = '';
  const partial = output.match(PARTIAL_SGR_TAIL_RE);
  if (partial && partial[0].length <= MAX_CARRY_LENGTH) {
    carry = partial[0];
    output = output.slice(0, output.length - carry.length);
  }

  return { output, events, carry };
}

/**
 * Wrap the real stdin in a stream Ink can consume, with mouse sequences
 * filtered out and surfaced on the returned event source instead.
 */
export function createMouseFilteredStdin(
  realStdin: NodeJS.ReadStream = process.stdin
): MouseFilteredStdin {
  const events = new EventEmitter();
  const proxy = new PassThrough();
  const decoder = new StringDecoder('utf8');
  let carry = '';

  // Ink drives raw mode and TTY detection through the stream it is given;
  // delegate those to the real stdin.
  const proxyAsTty = proxy as unknown as NodeJS.ReadStream;
  proxyAsTty.isTTY = realStdin.isTTY;
  proxyAsTty.setRawMode = (mode: boolean) => {
    if (typeof realStdin.setRawMode === 'function') {
      realStdin.setRawMode(mode);
    }
    return proxyAsTty;
  };
  proxyAsTty.ref = () => {
    realStdin.ref?.();
    return proxyAsTty;
  };
  proxyAsTty.unref = () => {
    realStdin.unref?.();
    return proxyAsTty;
  };

  const handleData = (chunk: Buffer | string) => {
    const text = carry + (typeof chunk === 'string' ? chunk : decoder.write(chunk));
    const result = extractMouseSequences(text);
    carry = result.carry;
    for (const mouseEvent of result.events) {
      events.emit('mouse', mouseEvent);
    }
    if (result.output) {
      proxy.write(result.output);
    }
  };

  realStdin.on('data', handleData);

  return {
    stdin: proxyAsTty,
    events,
    detach: () => {
      realStdin.off('data', handleData);
    },
  };
}
