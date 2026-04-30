/**
 * Web MIDI → DTX drum lane mapping.
 *
 * Model: a thin router over `MIDIAccess`. On every `midimessage` event from
 * the selected input port (or every port, when `portId` is null), parse
 * the 3-byte status-data1-data2 and fire a `LaneHitEvent` if it's a
 * note-on with velocity > 0 and the note maps to a drum lane.
 *
 * Note-offs (status 0x80 OR note-on with velocity 0 — running-status idiom)
 * are swallowed; the game doesn't care when the player lets go. Channel is
 * ignored — electronic kits always send on channel 10 (or any channel on a
 * DAW passthrough) and the note number alone disambiguates the pad.
 *
 * The default note map follows General MIDI Level 1 percussion
 * (https://midi.org/general-midi-level-1). Various electronic-kit
 * vendors use slightly different layouts but overlap heavily on 35/36
 * (kick) and 38 (snare); per-note remap UI is a phase-2 addition.
 */

import {
  Lane,
  type LaneValue,
  type LaneHitEvent,
  type LaneHitHandler,
} from './keyboard.js';

/** MIDI note number → DTX lane. General MIDI percussion. Multiple notes
 * can point at the same lane (43 "High Floor Tom" and 47 "Low-Mid Tom"
 * both map to FT / HT respectively; dual-zone cymbals hit bow + edge
 * with separate notes both mapping to CY). */
export const DEFAULT_MIDI_NOTE_MAP: Readonly<Record<number, LaneValue>> = {
  35: Lane.LBD, // Acoustic Bass Drum (left pedal)
  36: Lane.BD,  // Bass Drum 1
  38: Lane.SD,  // Acoustic Snare
  40: Lane.SD,  // Electric Snare
  42: Lane.HH,  // Closed Hi-Hat
  44: Lane.LP,  // Pedal Hi-Hat (left pedal)
  46: Lane.HHO, // Open Hi-Hat
  41: Lane.FT,  // Low Floor Tom
  43: Lane.FT,  // High Floor Tom
  45: Lane.LT,  // Low Tom
  47: Lane.HT,  // Low-Mid Tom
  48: Lane.HT,  // Hi-Mid Tom
  50: Lane.HT,  // High Tom
  49: Lane.CY,  // Crash Cymbal 1
  57: Lane.CY,  // Crash Cymbal 2
  51: Lane.RD,  // Ride Cymbal 1
  53: Lane.RD,  // Ride Bell
  59: Lane.RD,  // Ride Cymbal 2
  55: Lane.LC,  // Splash Cymbal (treat as left crash)
  52: Lane.LC,  // Chinese Cymbal
};

export interface MidiInputOptions {
  noteMap?: Partial<Record<number, LaneValue>>;
  /** If set, only messages from this input.id route. null = every input. */
  portId?: string | null;
}

export interface MidiPortInfo {
  id: string;
  name: string;
}

/** Pure parser: decode a MIDI message body to a LaneHitEvent or null.
 * Exported for unit tests — constructs identical output to what the
 * MidiInput handler emits from a real MIDIMessageEvent. */
export function midiMessageToLaneHit(
  data: Uint8Array | readonly number[],
  noteMap: Partial<Record<number, LaneValue>>,
  now: number,
): LaneHitEvent | null {
  if (data.length < 3) return null;
  const status = data[0]! & 0xf0;
  const note = data[1]!;
  const velocity = data[2]!;
  // Note-off (0x80) or note-on with velocity 0 (running-status note-off).
  if (status === 0x80) return null;
  if (status !== 0x90) return null;
  if (velocity === 0) return null;
  const lane = noteMap[note];
  if (lane === undefined) return null;
  return { lane, timestampMs: now, key: `midi-${note}` };
}

export class MidiInput {
  private readonly access: MIDIAccess;
  private readonly noteMap: Partial<Record<number, LaneValue>>;
  private portId: string | null;
  private readonly laneHandlers = new Set<LaneHitHandler>();
  private readonly portsChangedHandlers = new Set<(ports: MidiPortInfo[]) => void>();
  private readonly boundMessageHandler = (e: Event): void => {
    const ev = e as MIDIMessageEvent;
    if (!ev.data) return;
    const hit = midiMessageToLaneHit(ev.data, this.noteMap, performance.now());
    if (!hit) return;
    for (const h of this.laneHandlers) h(hit);
  };
  private readonly boundStateChangeHandler = (): void => {
    // Re-wire on connect/disconnect so a newly-plugged kit starts routing
    // without requiring a detach/attach cycle. listPorts() + the change
    // callback keep the Settings UI's dropdown fresh.
    this.rebindPorts();
    const ports = this.listPorts();
    for (const cb of this.portsChangedHandlers) cb(ports);
  };
  private attached = false;

  /** Request MIDI access. Returns null on unsupported browsers or denied
   * permission — callers should degrade silently rather than throw. */
  static async requestAccess(): Promise<MIDIAccess | null> {
    if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
      return null;
    }
    try {
      return await navigator.requestMIDIAccess({ sysex: false });
    } catch {
      return null;
    }
  }

  constructor(access: MIDIAccess, options: MidiInputOptions = {}) {
    this.access = access;
    this.noteMap = { ...DEFAULT_MIDI_NOTE_MAP, ...(options.noteMap ?? {}) };
    this.portId = options.portId ?? null;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.rebindPorts();
    this.access.addEventListener('statechange', this.boundStateChangeHandler);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.unbindAllPorts();
    this.access.removeEventListener('statechange', this.boundStateChangeHandler);
  }

  setPort(id: string | null): void {
    this.portId = id;
    if (this.attached) this.rebindPorts();
  }

  listPorts(): MidiPortInfo[] {
    const out: MidiPortInfo[] = [];
    this.access.inputs.forEach((input) => {
      out.push({ id: input.id, name: input.name ?? input.id });
    });
    return out;
  }

  onPortsChanged(cb: (ports: MidiPortInfo[]) => void): () => void {
    this.portsChangedHandlers.add(cb);
    return () => this.portsChangedHandlers.delete(cb);
  }

  onLaneHit(handler: LaneHitHandler): () => void {
    this.laneHandlers.add(handler);
    return () => this.laneHandlers.delete(handler);
  }

  private rebindPorts(): void {
    this.unbindAllPorts();
    this.access.inputs.forEach((input) => {
      if (this.portId !== null && input.id !== this.portId) return;
      input.addEventListener('midimessage', this.boundMessageHandler);
    });
  }

  private unbindAllPorts(): void {
    this.access.inputs.forEach((input) => {
      input.removeEventListener('midimessage', this.boundMessageHandler);
    });
  }
}
