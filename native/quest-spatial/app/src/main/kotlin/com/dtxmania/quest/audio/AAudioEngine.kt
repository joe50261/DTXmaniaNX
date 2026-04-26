package com.dtxmania.quest.audio

import java.nio.ByteBuffer

/**
 * Kotlin facade for the native AAudio engine. All methods delegate to
 * the JNI bindings in `cpp/jni_bindings.cpp`.
 *
 * Lifecycle:
 *
 *   1. [init] opens a low-latency AAudio output stream. Returns false
 *      if the device refuses (no audio hardware on emulator, etc.).
 *   2. Register sample PCM via [registerSample] before scheduling
 *      events that reference those ids.
 *   3. [start] begins running audio frames. The DSP-frame counter
 *      starts ticking up inside the audio callback.
 *   4. [scheduleEvent] queues a chip; the callback drains it once the
 *      running frame counter reaches `targetFrame`.
 *   5. [stop] pauses; the stream is still open. Resume with [start].
 *   6. [shutdown] closes the stream and releases resources.
 *
 * Phase 3A: the audio callback drains scheduled events but emits
 * silence — actual PCM mixing arrives in Phase 3B. So calling [start]
 * + [scheduleEvent] today produces no audible output. The schedule
 * path is exercised end-to-end (Kotlin → JNI → ring buffer → callback
 * drain) for shape validation.
 */
class AAudioEngine {

    /** Start (or restore) the AAudio output stream. Returns false if
     *  the platform refuses to open one. Callers should treat this as
     *  a hard error — the rhythm game can't run without audio. */
    fun init(): Boolean = nativeInit()

    /** Close the AAudio stream and release all native state. After
     *  this call [init] must be called again before any other method. */
    fun shutdown() = nativeShutdown()

    /** Begin writing audio frames. Returns false if the AAudio
     *  request fails (typically because [init] hasn't been called or
     *  failed). */
    fun start(): Boolean = nativeStart()

    /** Pause writing audio frames. Stream stays open; resume via
     *  [start]. */
    fun stop() = nativeStop()

    /** Sample rate the device negotiated (typically 48000). 0 before
     *  [init] succeeds. */
    val actualSampleRate: Int get() = nativeActualSampleRate()

    /** Frames-per-burst the device negotiated. The
     *  [com.dtxmania.quest.audio.Scheduler] uses this to size its
     *  lookahead window so each callback always has enough already-
     *  scheduled events to drain. 0 before [init] succeeds. */
    val actualFramesPerBurst: Int get() = nativeActualFramesPerBurst()

    /** Monotonic running frame counter, advanced inside the audio
     *  callback. 0 before the first callback fires. */
    val dspFrame: Long get() = nativeDspFrame()

    /**
     * Queue a sample-playback event for the given target frame.
     * Returns false if the ring buffer is currently full (caller
     * should retry next tick — schedule loop is expected to run at
     * tens of Hz, so a short stall is fine).
     *
     * @param sampleId  id from [SampleBank]
     * @param targetFrame  DSP frame at which playback should begin
     * @param gain  linear multiplier, 0..1+ (1.0 = unity)
     * @param pan  -1.0 = full left, 0 = centre, +1.0 = full right
     */
    fun scheduleEvent(
        sampleId: Int,
        targetFrame: Long,
        gain: Float = 1f,
        pan: Float = 0f,
    ): Boolean = nativeScheduleEvent(sampleId, targetFrame, gain, pan)

    /**
     * Register raw 16-bit interleaved stereo PCM data for `sampleId`.
     *
     * The [pcmData] **must** be a [ByteBuffer.allocateDirect]-allocated
     * buffer; the engine reads the bytes directly via
     * `GetDirectBufferAddress`. The caller is responsible for keeping
     * the buffer alive for the engine's lifetime — [SampleBank] holds
     * the references on the Kotlin side and clears them on shutdown.
     *
     * @param frameCount  number of stereo frames in the buffer (so the
     *  byte size is `frameCount * 2 channels * 2 bytes`).
     */
    fun registerSample(sampleId: Int, pcmData: ByteBuffer, frameCount: Int) {
        require(pcmData.isDirect) { "pcmData must be allocateDirect" }
        nativeRegisterSample(sampleId, pcmData, frameCount)
    }

    private external fun nativeInit(): Boolean
    private external fun nativeShutdown()
    private external fun nativeStart(): Boolean
    private external fun nativeStop()
    private external fun nativeActualSampleRate(): Int
    private external fun nativeActualFramesPerBurst(): Int
    private external fun nativeDspFrame(): Long
    private external fun nativeScheduleEvent(
        sampleId: Int, targetFrame: Long, gain: Float, pan: Float,
    ): Boolean
    private external fun nativeRegisterSample(
        sampleId: Int, pcmBuffer: ByteBuffer, frameCount: Int,
    )

    companion object {
        init {
            // The cpp/CMakeLists.txt produces this lib name. Loaded
            // once per process; subsequent AAudioEngine instances
            // reuse the same native state (the engine itself is a
            // singleton on the C++ side).
            System.loadLibrary("dtxmania_quest_audio")
        }
    }
}
