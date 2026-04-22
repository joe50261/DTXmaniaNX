import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIDI_NOTE_MAP,
  MidiInput,
  midiMessageToLaneHit,
} from './midi.js';
import { Lane, type LaneHitEvent } from './keyboard.js';

describe('midiMessageToLaneHit', () => {
  it('returns a LaneHitEvent for a status-0x9? note-on with velocity > 0 and a mapped note', () => {
    const hit = midiMessageToLaneHit(new Uint8Array([0x99, 38, 100]), DEFAULT_MIDI_NOTE_MAP, 123);
    expect(hit).not.toBeNull();
    expect(hit?.lane).toBe(Lane.SD);
    expect(hit?.timestampMs).toBe(123);
    expect(hit?.key).toBe('midi-38');
  });

  it('returns null for note-on with velocity 0 (running-status note-off idiom)', () => {
    const hit = midiMessageToLaneHit(new Uint8Array([0x90, 36, 0]), DEFAULT_MIDI_NOTE_MAP, 0);
    expect(hit).toBeNull();
  });

  it('returns null for status 0x80 (explicit note-off)', () => {
    const hit = midiMessageToLaneHit(new Uint8Array([0x80, 36, 100]), DEFAULT_MIDI_NOTE_MAP, 0);
    expect(hit).toBeNull();
  });

  it('returns null for unmapped note numbers', () => {
    const hit = midiMessageToLaneHit(new Uint8Array([0x90, 60, 100]), DEFAULT_MIDI_NOTE_MAP, 0);
    expect(hit).toBeNull();
  });

  it('returns null for non-note messages (control-change, pitch-bend, etc)', () => {
    expect(midiMessageToLaneHit(new Uint8Array([0xb0, 7, 127]), DEFAULT_MIDI_NOTE_MAP, 0)).toBeNull();
    expect(midiMessageToLaneHit(new Uint8Array([0xe0, 0, 64]), DEFAULT_MIDI_NOTE_MAP, 0)).toBeNull();
  });

  it('returns null for truncated messages (<3 bytes)', () => {
    expect(midiMessageToLaneHit(new Uint8Array([0x90, 36]), DEFAULT_MIDI_NOTE_MAP, 0)).toBeNull();
    expect(midiMessageToLaneHit(new Uint8Array([]), DEFAULT_MIDI_NOTE_MAP, 0)).toBeNull();
  });

  it('ignores the low nibble of the status byte (channel)', () => {
    // Channels 10 (0x99) and 1 (0x90) with the same note both route.
    const ch1 = midiMessageToLaneHit(new Uint8Array([0x90, 36, 100]), DEFAULT_MIDI_NOTE_MAP, 0);
    const ch10 = midiMessageToLaneHit(new Uint8Array([0x99, 36, 100]), DEFAULT_MIDI_NOTE_MAP, 0);
    expect(ch1?.lane).toBe(Lane.BD);
    expect(ch10?.lane).toBe(Lane.BD);
  });

  it('accepts an ordinary number array, not just Uint8Array', () => {
    const hit = midiMessageToLaneHit([0x90, 38, 127], DEFAULT_MIDI_NOTE_MAP, 42);
    expect(hit?.lane).toBe(Lane.SD);
  });
});

describe('DEFAULT_MIDI_NOTE_MAP — sanity', () => {
  it('maps the GM staples: 36 kick, 38 snare, 42 HH, 46 HHO, 49 crash, 51 ride', () => {
    expect(DEFAULT_MIDI_NOTE_MAP[36]).toBe(Lane.BD);
    expect(DEFAULT_MIDI_NOTE_MAP[38]).toBe(Lane.SD);
    expect(DEFAULT_MIDI_NOTE_MAP[42]).toBe(Lane.HH);
    expect(DEFAULT_MIDI_NOTE_MAP[46]).toBe(Lane.HHO);
    expect(DEFAULT_MIDI_NOTE_MAP[49]).toBe(Lane.CY);
    expect(DEFAULT_MIDI_NOTE_MAP[51]).toBe(Lane.RD);
  });
});

// Minimal MIDIInput / MIDIAccess shims. We only exercise what MidiInput
// actually reads: access.inputs (iterable .forEach with id/name),
// addEventListener on the access and each input, dispatchEvent.
class FakeMidiInputPort extends EventTarget {
  constructor(readonly id: string, readonly name: string) {
    super();
  }
  dispatchMessage(bytes: readonly number[]): void {
    // Real MIDIMessageEvent exposes .data; EventTarget lets us attach it
    // to a plain Event and the handler reads it cast-to-MIDIMessageEvent.
    const ev = new Event('midimessage') as Event & { data: Uint8Array };
    ev.data = new Uint8Array(bytes);
    this.dispatchEvent(ev);
  }
}

class FakeMidiAccess extends EventTarget {
  readonly inputs: Map<string, FakeMidiInputPort>;

  constructor(ports: FakeMidiInputPort[]) {
    super();
    this.inputs = new Map(ports.map((p) => [p.id, p]));
  }

  addPort(port: FakeMidiInputPort): void {
    this.inputs.set(port.id, port);
    this.dispatchEvent(new Event('statechange'));
  }
}

describe('MidiInput end-to-end', () => {
  it('routes midimessage events through midiMessageToLaneHit', () => {
    const port = new FakeMidiInputPort('p1', 'Kit 1');
    const access = new FakeMidiAccess([port]);
    const mi = new MidiInput(access as unknown as MIDIAccess);
    const hits: LaneHitEvent[] = [];
    mi.onLaneHit((e) => hits.push(e));
    mi.attach();

    port.dispatchMessage([0x99, 38, 100]); // SD
    port.dispatchMessage([0x99, 36, 100]); // BD
    port.dispatchMessage([0x99, 36, 0]);   // note-off idiom — suppressed
    port.dispatchMessage([0x80, 36, 100]); // explicit note-off — suppressed

    expect(hits.map((h) => h.lane)).toEqual([Lane.SD, Lane.BD]);
    mi.detach();
  });

  it('honours setPort("id") — only the selected port routes', () => {
    const p1 = new FakeMidiInputPort('p1', 'Kit 1');
    const p2 = new FakeMidiInputPort('p2', 'Virtual Cable');
    const access = new FakeMidiAccess([p1, p2]);
    const mi = new MidiInput(access as unknown as MIDIAccess);
    const hits: LaneHitEvent[] = [];
    mi.onLaneHit((e) => hits.push(e));
    mi.attach();
    mi.setPort('p1');

    p1.dispatchMessage([0x99, 36, 100]);
    p2.dispatchMessage([0x99, 36, 100]); // filtered out

    expect(hits).toHaveLength(1);

    // Switch to p2 — p1 should stop routing.
    mi.setPort('p2');
    p1.dispatchMessage([0x99, 38, 100]); // filtered
    p2.dispatchMessage([0x99, 38, 100]);
    expect(hits.map((h) => h.lane)).toEqual([Lane.BD, Lane.SD]);

    mi.detach();
  });

  it('fires onPortsChanged when MIDIAccess emits statechange', () => {
    const p1 = new FakeMidiInputPort('p1', 'Kit 1');
    const access = new FakeMidiAccess([p1]);
    const mi = new MidiInput(access as unknown as MIDIAccess);
    const snapshots: string[][] = [];
    mi.onPortsChanged((ports) => snapshots.push(ports.map((p) => p.id)));
    mi.attach();

    access.addPort(new FakeMidiInputPort('p2', 'Kit 2'));
    expect(snapshots[snapshots.length - 1]).toEqual(['p1', 'p2']);
    mi.detach();
  });

  it('detach() stops routing from all ports', () => {
    const port = new FakeMidiInputPort('p1', 'Kit');
    const access = new FakeMidiAccess([port]);
    const mi = new MidiInput(access as unknown as MIDIAccess);
    const hits: LaneHitEvent[] = [];
    mi.onLaneHit((e) => hits.push(e));
    mi.attach();
    port.dispatchMessage([0x99, 36, 100]);
    expect(hits).toHaveLength(1);

    mi.detach();
    port.dispatchMessage([0x99, 36, 100]);
    expect(hits).toHaveLength(1); // no new hit
  });
});
