import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  createMouseFilteredStdin,
  createDoubleClickTracker,
  extractMouseSequences,
  type SidebarMouseEvent,
} from '../src/utils/sidebarMouse.js';

describe('extractMouseSequences', () => {
  it('passes plain keyboard input through untouched', () => {
    const result = extractMouseSequences('j');
    expect(result).toEqual({ output: 'j', events: [], carry: '' });
  });

  it('passes arrow keys and a bare escape through untouched', () => {
    expect(extractMouseSequences('\x1b[A').output).toBe('\x1b[A');
    expect(extractMouseSequences('\x1b').output).toBe('\x1b');
    expect(extractMouseSequences('\x1b').carry).toBe('');
    expect(extractMouseSequences('\x1b[').carry).toBe('');
  });

  it('strips an SGR press sequence and emits an event', () => {
    const result = extractMouseSequences('\x1b[<0;12;5M');
    expect(result.output).toBe('');
    expect(result.events).toEqual([
      { type: 'press', button: 0, col: 12, row: 5 },
    ]);
  });

  it('strips an SGR release sequence and emits an event', () => {
    const result = extractMouseSequences('\x1b[<0;12;5m');
    expect(result.output).toBe('');
    expect(result.events).toEqual([
      { type: 'release', button: 0, col: 12, row: 5 },
    ]);
  });

  it('strips modifier bits from the button but keeps wheel buttons', () => {
    expect(extractMouseSequences('\x1b[<4;3;2M').events[0].button).toBe(0); // shift+left
    expect(extractMouseSequences('\x1b[<64;3;2M').events[0].button).toBe(64); // wheel up
    expect(extractMouseSequences('\x1b[<65;3;2M').events[0].button).toBe(65); // wheel down
  });

  it('extracts mouse sequences embedded in other input', () => {
    const result = extractMouseSequences('a\x1b[<0;1;2Mb');
    expect(result.output).toBe('ab');
    expect(result.events).toHaveLength(1);
  });

  it('handles multiple sequences in one chunk', () => {
    const result = extractMouseSequences('\x1b[<0;1;2M\x1b[<0;1;2m');
    expect(result.output).toBe('');
    expect(result.events.map((event) => event.type)).toEqual([
      'press',
      'release',
    ]);
  });

  it('carries an unambiguous partial mouse sequence to the next chunk', () => {
    const first = extractMouseSequences('\x1b[<0;1');
    expect(first.output).toBe('');
    expect(first.carry).toBe('\x1b[<0;1');

    const second = extractMouseSequences(first.carry + ';2M');
    expect(second.output).toBe('');
    expect(second.carry).toBe('');
    expect(second.events).toEqual([
      { type: 'press', button: 0, col: 1, row: 2 },
    ]);
  });

  it('strips legacy X10 mouse sequences defensively', () => {
    const result = extractMouseSequences('\x1b[M !!x');
    expect(result.output).toBe('x');
    expect(result.events).toEqual([]);
  });
});

describe('createDoubleClickTracker', () => {
  it('reports a double-click for two quick clicks on the same item', () => {
    const isDoubleClick = createDoubleClickTracker(400);
    expect(isDoubleClick(2, 1000)).toBe(false);
    expect(isDoubleClick(2, 1300)).toBe(true);
  });

  it('does not pair clicks on different items or slow clicks', () => {
    const isDoubleClick = createDoubleClickTracker(400);
    expect(isDoubleClick(2, 1000)).toBe(false);
    expect(isDoubleClick(3, 1100)).toBe(false); // different item
    expect(isDoubleClick(3, 1400)).toBe(true);

    expect(isDoubleClick(1, 2000)).toBe(false);
    expect(isDoubleClick(1, 2500)).toBe(false); // too slow
  });

  it('requires a full new pair after a completed double-click', () => {
    const isDoubleClick = createDoubleClickTracker(400);
    expect(isDoubleClick(0, 1000)).toBe(false);
    expect(isDoubleClick(0, 1100)).toBe(true);
    expect(isDoubleClick(0, 1200)).toBe(false); // triple click doesn't re-fire
    expect(isDoubleClick(0, 1300)).toBe(true);
  });
});

describe('createMouseFilteredStdin', () => {
  function makeFakeStdin(): NodeJS.ReadStream {
    const emitter = new EventEmitter() as unknown as NodeJS.ReadStream;
    emitter.isTTY = true;
    (emitter as unknown as { setRawMode: (mode: boolean) => unknown }).setRawMode = () => emitter;
    (emitter as unknown as { ref: () => unknown }).ref = () => emitter;
    (emitter as unknown as { unref: () => unknown }).unref = () => emitter;
    return emitter;
  }

  it('forwards keyboard input to the proxy and mouse events to the emitter', async () => {
    const fakeStdin = makeFakeStdin();
    const { stdin, events, detach } = createMouseFilteredStdin(fakeStdin);

    const received: SidebarMouseEvent[] = [];
    events.on('mouse', (event) => received.push(event));
    const chunks: string[] = [];
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => chunks.push(String(chunk)));

    (fakeStdin as unknown as EventEmitter).emit('data', Buffer.from('j\x1b[<0;7;3Mk'));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));

    expect(chunks.join('')).toBe('jk');
    expect(received).toEqual([{ type: 'press', button: 0, col: 7, row: 3 }]);

    detach();
    (fakeStdin as unknown as EventEmitter).emit('data', Buffer.from('\x1b[<0;1;1M'));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    expect(received).toHaveLength(1);
  });

  it('reassembles a mouse sequence split across chunks', async () => {
    const fakeStdin = makeFakeStdin();
    const { stdin, events } = createMouseFilteredStdin(fakeStdin);

    const received: SidebarMouseEvent[] = [];
    events.on('mouse', (event) => received.push(event));
    const chunks: string[] = [];
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => chunks.push(String(chunk)));

    (fakeStdin as unknown as EventEmitter).emit('data', Buffer.from('\x1b[<0;12'));
    (fakeStdin as unknown as EventEmitter).emit('data', Buffer.from(';34M'));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));

    expect(chunks.join('')).toBe('');
    expect(received).toEqual([{ type: 'press', button: 0, col: 12, row: 34 }]);
  });

  it('delegates raw mode and TTY detection to the real stdin', () => {
    const fakeStdin = makeFakeStdin();
    let rawMode: boolean | undefined;
    (fakeStdin as unknown as { setRawMode: (mode: boolean) => unknown }).setRawMode = (mode: boolean) => {
      rawMode = mode;
      return fakeStdin;
    };

    const { stdin } = createMouseFilteredStdin(fakeStdin);
    expect(stdin.isTTY).toBe(true);
    stdin.setRawMode(true);
    expect(rawMode).toBe(true);
  });
});
