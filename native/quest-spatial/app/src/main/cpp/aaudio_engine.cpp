// aaudio_engine.cpp — implementation. See header for scope.
//
// Phase 3A guarantees:
//   - The engine opens a real AAudio low-latency stream.
//   - The audio callback runs without blocking (no allocations, no
//     locks beyond the lockfree ring buffer).
//   - Scheduled events are accepted and drained.
//   - The output is silent until Phase 3B fills in PCM mixing.
//
// All behaviour past "stream opens cleanly" is unverified outside a
// real Quest 3.

#include "aaudio_engine.h"

#include <aaudio/AAudio.h>
#include <android/log.h>
#include <atomic>
#include <cstring>
#include <mutex>

#define LOG_TAG "dtxmania_audio"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace dtxmania_audio {
namespace {

// ----------------------------------------------------------------------
// Lockfree single-producer / single-consumer ring buffer of events.
//
// Producer: Kotlin scheduler thread (one writer at a time).
// Consumer: AAudio data callback (one reader at a time, on a real-time
//           audio thread — must not block, allocate, or take locks).
//
// Capacity is a power of two so head/tail wraparound is a single mask.
// 1024 events is enough for a few seconds of lookahead even at the
// densest DTX charts (rough estimate: 1000 chips/min ≈ 17/s, so a
// 1-second lookahead buffers ~17 events; we have 60x headroom).
// ----------------------------------------------------------------------

struct ScheduledEvent {
    int32_t sample_id;
    int64_t target_frame;
    float gain;
    float pan;
};

constexpr size_t kEventCapacity = 1024;
constexpr size_t kEventCapacityMask = kEventCapacity - 1;
static_assert((kEventCapacity & kEventCapacityMask) == 0,
              "kEventCapacity must be a power of two");

class EventRing {
public:
    bool push(const ScheduledEvent& ev) {
        const size_t head = head_.load(std::memory_order_relaxed);
        const size_t tail = tail_.load(std::memory_order_acquire);
        if ((head - tail) >= kEventCapacity) return false;
        events_[head & kEventCapacityMask] = ev;
        head_.store(head + 1, std::memory_order_release);
        return true;
    }

    // Returns true and copies into `out` if the next event is due
    // (target_frame <= current_frame). Otherwise returns false.
    bool pop_if_due(int64_t current_frame, ScheduledEvent& out) {
        const size_t tail = tail_.load(std::memory_order_relaxed);
        const size_t head = head_.load(std::memory_order_acquire);
        if (head == tail) return false;
        const ScheduledEvent& peek = events_[tail & kEventCapacityMask];
        if (peek.target_frame > current_frame) return false;
        out = peek;
        tail_.store(tail + 1, std::memory_order_release);
        return true;
    }

    void clear() {
        head_.store(0, std::memory_order_relaxed);
        tail_.store(0, std::memory_order_relaxed);
    }

private:
    ScheduledEvent events_[kEventCapacity]{};
    std::atomic<size_t> head_{0};
    std::atomic<size_t> tail_{0};
};

// ----------------------------------------------------------------------
// Sample bank. Phase 3A only stores the registered pointers + lengths;
// Phase 3B reads them inside the callback to mix PCM into the output.
//
// Indexing is sparse — DTX wav ids range 1..(36^2-1) = 1..1295. We use
// a fixed-size array indexed by id; null entries mean "no sample".
// ----------------------------------------------------------------------

constexpr int32_t kMaxSampleId = 1296;

struct SampleEntry {
    const int16_t* pcm{nullptr};
    int32_t frame_count{0};
};

// Audio callback reads, JNI thread writes — guarded by a mutex held
// only on the writer side. The callback never takes the mutex; it
// reads pcm/frame_count via relaxed atomic loads. Phase 3B will
// formalise this further; for now the bank is unused at runtime.
struct State {
    AAudioStream* stream{nullptr};
    int32_t actual_sample_rate{0};
    int32_t actual_frames_per_burst{0};
    std::atomic<int64_t> dsp_frame{0};
    EventRing ring;
    std::mutex bank_mutex;
    SampleEntry bank[kMaxSampleId];
};

State& state() {
    static State s;
    return s;
}

aaudio_data_callback_result_t data_callback(
    AAudioStream* /*stream*/,
    void* user_data,
    void* audio_data,
    int32_t num_frames
) {
    State* s = static_cast<State*>(user_data);
    const int64_t frame_at_start = s->dsp_frame.load(std::memory_order_relaxed);

    // Drain due events. Phase 3A: just consume them so the ring drains;
    // Phase 3B will mix matching sample data into `audio_data` here.
    ScheduledEvent ev{};
    while (s->ring.pop_if_due(frame_at_start + num_frames, ev)) {
        // no-op for Phase 3A — stub-mixed at silence level
        (void)ev;
    }

    // Output silence until Phase 3B implements actual mixing.
    std::memset(audio_data, 0, sizeof(int16_t) * num_frames * kRequestedChannelCount);

    s->dsp_frame.store(frame_at_start + num_frames, std::memory_order_release);
    return AAUDIO_CALLBACK_RESULT_CONTINUE;
}

void error_callback(AAudioStream* /*stream*/, void* /*user_data*/, aaudio_result_t error) {
    LOGE("AAudio error callback fired: %s", AAudio_convertResultToText(error));
}

}  // namespace

bool engine_init() {
    State& s = state();
    if (s.stream != nullptr) return true;

    AAudioStreamBuilder* builder = nullptr;
    aaudio_result_t r = AAudio_createStreamBuilder(&builder);
    if (r != AAUDIO_OK) {
        LOGE("AAudio_createStreamBuilder failed: %s", AAudio_convertResultToText(r));
        return false;
    }

    AAudioStreamBuilder_setDirection(builder, AAUDIO_DIRECTION_OUTPUT);
    AAudioStreamBuilder_setSharingMode(builder, AAUDIO_SHARING_MODE_EXCLUSIVE);
    AAudioStreamBuilder_setPerformanceMode(builder, AAUDIO_PERFORMANCE_MODE_LOW_LATENCY);
    AAudioStreamBuilder_setFormat(builder, AAUDIO_FORMAT_PCM_I16);
    AAudioStreamBuilder_setChannelCount(builder, kRequestedChannelCount);
    AAudioStreamBuilder_setSampleRate(builder, kRequestedSampleRate);
    AAudioStreamBuilder_setUsage(builder, AAUDIO_USAGE_GAME);
    AAudioStreamBuilder_setContentType(builder, AAUDIO_CONTENT_TYPE_MUSIC);
    AAudioStreamBuilder_setDataCallback(builder, data_callback, &s);
    AAudioStreamBuilder_setErrorCallback(builder, error_callback, &s);

    r = AAudioStreamBuilder_openStream(builder, &s.stream);
    AAudioStreamBuilder_delete(builder);

    if (r != AAUDIO_OK || s.stream == nullptr) {
        LOGE("AAudio openStream failed: %s", AAudio_convertResultToText(r));
        s.stream = nullptr;
        return false;
    }

    s.actual_sample_rate = AAudioStream_getSampleRate(s.stream);
    s.actual_frames_per_burst = AAudioStream_getFramesPerBurst(s.stream);
    s.dsp_frame.store(0, std::memory_order_relaxed);
    s.ring.clear();

    LOGI("AAudio stream opened: rate=%d frames/burst=%d",
         s.actual_sample_rate, s.actual_frames_per_burst);
    return true;
}

void engine_shutdown() {
    State& s = state();
    if (s.stream == nullptr) return;
    AAudioStream_requestStop(s.stream);
    AAudioStream_close(s.stream);
    s.stream = nullptr;
    s.actual_sample_rate = 0;
    s.actual_frames_per_burst = 0;
    s.dsp_frame.store(0, std::memory_order_relaxed);
    s.ring.clear();
    {
        std::lock_guard<std::mutex> lock(s.bank_mutex);
        for (auto& e : s.bank) e = SampleEntry{};
    }
}

bool engine_start() {
    State& s = state();
    if (s.stream == nullptr) return false;
    aaudio_result_t r = AAudioStream_requestStart(s.stream);
    if (r != AAUDIO_OK) {
        LOGE("AAudioStream_requestStart failed: %s", AAudio_convertResultToText(r));
        return false;
    }
    return true;
}

void engine_stop() {
    State& s = state();
    if (s.stream == nullptr) return;
    AAudioStream_requestStop(s.stream);
}

int32_t engine_actual_sample_rate() { return state().actual_sample_rate; }
int32_t engine_actual_frames_per_burst() { return state().actual_frames_per_burst; }

int64_t engine_dsp_frame() {
    return state().dsp_frame.load(std::memory_order_acquire);
}

bool engine_schedule_event(int32_t sample_id, int64_t target_frame, float gain, float pan) {
    return state().ring.push(ScheduledEvent{sample_id, target_frame, gain, pan});
}

void engine_register_sample(int32_t sample_id, const int16_t* pcm_data, int32_t frame_count) {
    if (sample_id < 0 || sample_id >= kMaxSampleId) {
        LOGW("engine_register_sample: out-of-range id %d", sample_id);
        return;
    }
    State& s = state();
    std::lock_guard<std::mutex> lock(s.bank_mutex);
    s.bank[sample_id] = SampleEntry{pcm_data, frame_count};
}

}  // namespace dtxmania_audio
