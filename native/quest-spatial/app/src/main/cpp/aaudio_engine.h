// aaudio_engine.h — public C-style entry points for the audio engine.
//
// Phase 3A scope: open a low-latency AAudio stream, expose a lockfree
// ring buffer of scheduled sample events, drain and return silence
// from the audio callback. Actual sample-data mixing happens in Phase
// 3B once we can verify behaviour on a Quest 3 (the C++ in this file
// is otherwise compile-only — CI builds it but cannot run it).

#pragma once

#include <cstdint>

namespace dtxmania_audio {

// Stream config the engine requests. AAudio may negotiate a different
// rate / size — call engine_actual_sample_rate() / engine_actual_frames_per_burst()
// after engine_init() to read what the device gave us.
constexpr int32_t kRequestedSampleRate = 48000;
constexpr int32_t kRequestedChannelCount = 2;

// Open the AAudio output stream in low-latency mode. Returns true on
// success. Idempotent — repeat calls without engine_shutdown() are
// no-ops returning the previous result.
bool engine_init();

// Stop and release the AAudio stream. Safe to call without a prior
// engine_init().
void engine_shutdown();

// Begin / pause writing audio frames. Stream stays open across stop.
bool engine_start();
void engine_stop();

// Sample rate the device negotiated. 0 if not yet initialised.
int32_t engine_actual_sample_rate();

// Frames-per-burst the device negotiated. Used by the Kotlin scheduler
// to size its lookahead window. 0 if not yet initialised.
int32_t engine_actual_frames_per_burst();

// Monotonic running frame counter. Increments inside the audio
// callback. 0 before the first callback fires.
int64_t engine_dsp_frame();

// Schedule a sample to play once the audio callback's running frame
// counter reaches `target_frame`. Returns false if the ring buffer is
// full (caller should back off and retry next tick).
//
// `gain` is a linear multiplier (0.0 = silent, 1.0 = unity).
// `pan` is in [-1.0, 1.0] (-1 = full left, 0 = centre, +1 = full right).
//
// Phase 3A: events are accepted and drained inside the callback but
// no PCM mixing happens — the output remains silent. Phase 3B wires
// up sample-data → output mixing.
bool engine_schedule_event(int32_t sample_id, int64_t target_frame, float gain, float pan);

// Register raw signed-16-bit interleaved PCM data for `sample_id`.
// `frame_count` is the number of stereo frames (so the byte size is
// frame_count * 2 channels * 2 bytes).
//
// The caller (Kotlin SampleBank) is responsible for keeping the
// underlying buffer alive until either engine_shutdown() or a
// subsequent register_sample replaces this id. The engine does not
// copy the bytes — it stores the pointer.
void engine_register_sample(int32_t sample_id, const int16_t* pcm_data, int32_t frame_count);

}  // namespace dtxmania_audio
