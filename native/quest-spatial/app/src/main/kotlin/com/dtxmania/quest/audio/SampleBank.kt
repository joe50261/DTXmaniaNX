package com.dtxmania.quest.audio

import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import com.dtxmania.quest.dtxcore.scanner.FileSystemBackend
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Decodes hit-sample audio files (`.wav` / `.ogg` / `.mp3`) once via
 * Android's [MediaExtractor] + [MediaCodec], converts to 16-bit
 * interleaved stereo PCM at the engine's negotiated sample rate, and
 * registers the resulting buffer with [AAudioEngine].
 *
 * **Phase 3A scope: this class is compile-only.** MediaExtractor /
 * MediaCodec cannot be exercised in a JVM unit test, and the engine
 * itself isn't mixing yet, so end-to-end audio verification has to
 * happen on a Quest 3 (Phase 9). What CI does verify:
 *
 *   - the class compiles against the Android API
 *   - the [load] method's signature matches what
 *     [com.dtxmania.quest.dtxcore.scanner.SongScanner] needs to call
 *
 * Implementation outline (left here so Phase 3B / on-device work has a
 * starting point):
 *
 *   1. Spool the [FileSystemBackend.readFile] bytes to a tmp file —
 *      MediaExtractor needs a `setDataSource(path)` or a
 *      `MediaDataSource`; spooling is simpler and the file count is
 *      bounded (a chart's #WAV table has ≤ 1295 entries).
 *   2. Find the audio track via `MediaExtractor.getTrackFormat`.
 *   3. Configure a decoder via `MediaCodec.createDecoderByType(mime)`.
 *   4. Pump input buffers and accumulate output PCM.
 *   5. If the decoder rate / channel layout differs from the engine's,
 *      resample (Phase 3B — for v1 most DTX samples are already
 *      48 kHz / 2 ch / 16-bit, so we'll start by rejecting mismatched
 *      formats and revisit if many real-world packs need resampling).
 *
 * Sample IDs are the same as DTX `#WAVxx` zz-ids (1..1295).
 */
class SampleBank(
    private val engine: AAudioEngine,
    private val cacheDir: File,
) {
    private val buffers = HashMap<Int, ByteBuffer>()

    /** Decode and register a single sample. Returns true on success. */
    fun load(sampleId: Int, fs: FileSystemBackend, path: String): Boolean {
        return try {
            val bytes = fs.readFile(path)
            val tmp = spoolToTmp(bytes, sampleId)
            val pcm = decodeToPcm(tmp) ?: return false
            tmp.delete()
            register(sampleId, pcm)
            true
        } catch (_: Exception) {
            false
        }
    }

    /** Drop all registered samples. Call from `onDestroy` so the
     *  direct ByteBuffers are released alongside the AAudio stream. */
    fun clear() {
        buffers.clear()
    }

    // -----------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------

    private fun spoolToTmp(bytes: ByteArray, sampleId: Int): File {
        val tmp = File(cacheDir, "sample-$sampleId.bin")
        FileOutputStream(tmp).use { it.write(bytes) }
        return tmp
    }

    private fun decodeToPcm(file: File): Pcm? {
        val extractor = MediaExtractor()
        try {
            extractor.setDataSource(file.absolutePath)
            val trackIndex = (0 until extractor.trackCount).firstOrNull { i ->
                extractor.getTrackFormat(i)
                    .getString(MediaFormat.KEY_MIME)
                    ?.startsWith("audio/") == true
            } ?: return null
            extractor.selectTrack(trackIndex)
            val format = extractor.getTrackFormat(trackIndex)
            val mime = format.getString(MediaFormat.KEY_MIME) ?: return null
            val sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            val channelCount = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)

            val codec = MediaCodec.createDecoderByType(mime)
            return try {
                codec.configure(format, null, null, 0)
                codec.start()
                val pcmBytes = pumpDecoder(extractor, codec)
                Pcm(
                    bytes = pcmBytes,
                    sampleRate = sampleRate,
                    channelCount = channelCount,
                )
            } finally {
                codec.stop()
                codec.release()
            }
        } finally {
            extractor.release()
        }
    }

    private fun pumpDecoder(
        extractor: MediaExtractor,
        codec: MediaCodec,
    ): ByteArray {
        val out = ArrayList<Byte>()
        val info = MediaCodec.BufferInfo()
        var sawInputEos = false
        var sawOutputEos = false
        val timeoutUs = 10_000L

        while (!sawOutputEos) {
            if (!sawInputEos) {
                val inIdx = codec.dequeueInputBuffer(timeoutUs)
                if (inIdx >= 0) {
                    val inBuf = codec.getInputBuffer(inIdx) ?: continue
                    val read = extractor.readSampleData(inBuf, 0)
                    if (read < 0) {
                        codec.queueInputBuffer(
                            inIdx, 0, 0, 0,
                            MediaCodec.BUFFER_FLAG_END_OF_STREAM,
                        )
                        sawInputEos = true
                    } else {
                        codec.queueInputBuffer(inIdx, 0, read, extractor.sampleTime, 0)
                        extractor.advance()
                    }
                }
            }
            val outIdx = codec.dequeueOutputBuffer(info, timeoutUs)
            if (outIdx >= 0) {
                val outBuf = codec.getOutputBuffer(outIdx)
                if (outBuf != null && info.size > 0) {
                    val chunk = ByteArray(info.size)
                    outBuf.position(info.offset)
                    outBuf.get(chunk, 0, info.size)
                    for (b in chunk) out.add(b)
                }
                codec.releaseOutputBuffer(outIdx, false)
                if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                    sawOutputEos = true
                }
            }
        }
        return out.toByteArray()
    }

    private fun register(sampleId: Int, pcm: Pcm) {
        val frameSize = 2 /* channels */ * 2 /* bytes per int16 */
        val frameCount = pcm.bytes.size / frameSize
        // Direct ByteBuffer so the JNI side can read via
        // GetDirectBufferAddress without copying. We hold the
        // reference in `buffers` to keep the native pointer valid.
        val direct = ByteBuffer.allocateDirect(pcm.bytes.size).order(ByteOrder.LITTLE_ENDIAN)
        direct.put(pcm.bytes).rewind()
        buffers[sampleId] = direct
        engine.registerSample(sampleId, direct, frameCount)
    }

    private data class Pcm(
        val bytes: ByteArray,
        val sampleRate: Int,
        val channelCount: Int,
    ) {
        // data class equals/hashCode with a ByteArray field would
        // compare references — override to compare contents so unit
        // tests (when added) can use simple assertEquals.
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Pcm) return false
            return bytes.contentEquals(other.bytes) &&
                sampleRate == other.sampleRate &&
                channelCount == other.channelCount
        }
        override fun hashCode(): Int = bytes.contentHashCode() * 31 +
            sampleRate * 31 + channelCount
    }

    @Suppress("unused") private val audioFormatHint = AudioFormat.ENCODING_PCM_16BIT
}
