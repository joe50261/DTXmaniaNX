// jni_bindings.cpp — JNI glue between Kotlin AAudioEngine and the C++
// audio engine.
//
// All entry points live in com.dtxmania.quest.audio.AAudioEngine on the
// Kotlin side. Method names follow the standard
// Java_<package>_<Class>_<method> mangling.
//
// Sample data crosses the boundary as a direct java.nio.ByteBuffer so
// the engine can read 16-bit PCM bytes without an extra copy. The
// caller (SampleBank) is responsible for keeping the ByteBuffer alive
// for the engine's lifetime.

#include "aaudio_engine.h"

#include <jni.h>
#include <android/log.h>
#include <cstdint>

#define LOG_TAG "dtxmania_audio_jni"
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, LOG_TAG, __VA_ARGS__)

extern "C" {

JNIEXPORT jboolean JNICALL
Java_com_dtxmania_quest_audio_AAudioEngine_nativeInit(JNIEnv* /*env*/, jobject /*thiz*/) {
    return dtxmania_audio::engine_init() ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_dtxmania_quest_audio_AAudioEngine_nativeShutdown(JNIEnv* /*env*/, jobject /*thiz*/) {
    dtxmania_audio::engine_shutdown();
}

JNIEXPORT jboolean JNICALL
Java_com_dtxmania_quest_audio_AAudioEngine_nativeStart(JNIEnv* /*env*/, jobject /*thiz*/) {
    return dtxmania_audio::engine_start() ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_dtxmania_quest_audio_AAudioEngine_nativeStop(JNIEnv* /*env*/, jobject /*thiz*/) {
    dtxmania_audio::engine_stop();
}

JNIEXPORT jint JNICALL
Java_com_dtxmania_quest_audio_AAudioEngine_nativeActualSampleRate(JNIEnv* /*env*/, jobject /*thiz*/) {
    return dtxmania_audio::engine_actual_sample_rate();
}

JNIEXPORT jint JNICALL
Java_com_dtxmania_quest_audio_AAudioEngine_nativeActualFramesPerBurst(JNIEnv* /*env*/, jobject /*thiz*/) {
    return dtxmania_audio::engine_actual_frames_per_burst();
}

JNIEXPORT jlong JNICALL
Java_com_dtxmania_quest_audio_AAudioEngine_nativeDspFrame(JNIEnv* /*env*/, jobject /*thiz*/) {
    return dtxmania_audio::engine_dsp_frame();
}

JNIEXPORT jboolean JNICALL
Java_com_dtxmania_quest_audio_AAudioEngine_nativeScheduleEvent(
    JNIEnv* /*env*/, jobject /*thiz*/,
    jint sample_id, jlong target_frame, jfloat gain, jfloat pan
) {
    return dtxmania_audio::engine_schedule_event(sample_id, target_frame, gain, pan)
        ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_dtxmania_quest_audio_AAudioEngine_nativeRegisterSample(
    JNIEnv* env, jobject /*thiz*/,
    jint sample_id, jobject pcm_buffer, jint frame_count
) {
    if (pcm_buffer == nullptr) {
        LOGW("nativeRegisterSample: pcm_buffer is null for id %d", sample_id);
        return;
    }
    void* addr = env->GetDirectBufferAddress(pcm_buffer);
    if (addr == nullptr) {
        LOGW("nativeRegisterSample: GetDirectBufferAddress returned null for id %d "
             "— ByteBuffer must be allocateDirect", sample_id);
        return;
    }
    dtxmania_audio::engine_register_sample(
        sample_id, static_cast<const int16_t*>(addr), frame_count
    );
}

}  // extern "C"
