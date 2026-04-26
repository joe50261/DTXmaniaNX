package com.dtxmania.quest.dtxcore

import com.dtxmania.quest.dtxcore.model.Channel
import com.dtxmania.quest.dtxcore.model.isDrumLane
import com.dtxmania.quest.dtxcore.parser.parseDtx
import com.dtxmania.quest.dtxcore.scoring.Judgment
import com.dtxmania.quest.dtxcore.scoring.Rank
import com.dtxmania.quest.dtxcore.scoring.ScoreTracker
import com.dtxmania.quest.dtxcore.scoring.computeAchievementRate
import com.dtxmania.quest.dtxcore.scoring.computeRank
import com.dtxmania.quest.dtxcore.timing.computeTiming
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * End-to-end run from raw DTX text → parser → timing → scoring. Same
 * fixture (`simple-rock.dtx`) and assertions as
 * `web/packages/dtx-core/tests/e2e.test.ts`. The fixture lives under
 * `src/test/resources/fixtures/` and is loaded via the test classpath
 * so the file path doesn't bake `cwd`-specific assumptions into the
 * suite.
 */
class E2eTest {

    private val text: String = run {
        val url = E2eTest::class.java.getResource("/fixtures/simple-rock.dtx")
            ?: error("simple-rock.dtx fixture missing from test resources")
        url.readText(Charsets.UTF_8)
    }
    private val song = computeTiming(parseDtx(text))

    @Test fun `parses metadata`() {
        assertEquals("Simple Rock", song.title)
        assertEquals("Test", song.artist)
        assertEquals(120.0, song.baseBpm)
        assertEquals(300, song.drumLevel)
    }

    @Test fun `defines four WAV entries`() {
        assertEquals(4, song.wavTable.size)
        assertEquals("kick.wav", song.wavTable[1]?.path)
        assertEquals("crash.wav", song.wavTable[4]?.path)
    }

    @Test fun `computes plausible duration with mid-song BPM change`() {
        // m0+m1 at 120 BPM = 4000ms; m2 at 240 BPM = 1000ms;
        // m3 at 120 BPM (after ch.03 reset) = 2000ms. Expected ≈ 7000ms.
        assertTrue(song.durationMs > 6900) { "duration=${song.durationMs}" }
        assertTrue(song.durationMs < 7100) { "duration=${song.durationMs}" }
    }

    @Test fun `places the crash on beat 1 of measure 3 exactly at 5000ms`() {
        val crash = song.chips.firstOrNull { it.channel == Channel.CYMBAL }
        assertNotNull(crash)
        assertEquals(5000.0, crash!!.playbackTimeMs, 0.1)
    }

    @Test fun `counts drum chips correctly across all four measures`() {
        val drumChips = song.chips.filter {
            it.channel >= Channel.HI_HAT_CLOSE && it.channel <= Channel.LEFT_BASS_DRUM
        }
        // m0: 4 BD + 2 SD + 8 HH = 14
        // m1: 8 BD = 8
        // m2: 4 BD = 4
        // m3: 1 CY = 1
        assertEquals(14 + 8 + 4 + 1, drumChips.size)
    }

    @Test fun `perfect-all run scores exactly 1,000,000`() {
        val notes = song.chips.filter {
            it.channel >= Channel.HI_HAT_CLOSE && it.channel <= Channel.LEFT_BASS_DRUM
        }
        val tracker = ScoreTracker(notes.size)
        repeat(notes.size) { tracker.record(Judgment.PERFECT) }
        assertEquals(1_000_000, tracker.snapshot().score)
    }

    @Test fun `all-miss run scores 0`() {
        val notes = song.chips.filter {
            it.channel >= Channel.HI_HAT_CLOSE && it.channel <= Channel.LEFT_BASS_DRUM
        }
        val tracker = ScoreTracker(notes.size)
        repeat(notes.size) { tracker.record(Judgment.MISS) }
        val snap = tracker.snapshot()
        assertEquals(0, snap.score)
        assertEquals(0, snap.maxCombo)
    }

    @Test fun `all-auto playthrough - every drum chip counted as auto, rank collapses to E`() {
        val playables = song.chips.filter { isDrumLane(it.channel) }
        assertTrue(playables.isNotEmpty())
        val tracker = ScoreTracker(playables.size)
        repeat(playables.size) { tracker.recordAuto() }
        val snap = tracker.snapshot()
        assertEquals(playables.size, snap.totalNotes)
        assertEquals(playables.size, snap.autoCount)
        // effective denominator = totalNotes - autoCount = 0; score and
        // achievement collapse to 0.
        assertEquals(0, snap.score)
        assertEquals(0, snap.counts[Judgment.PERFECT])
        assertEquals(0, snap.counts[Judgment.MISS])
        assertEquals(0, snap.maxCombo)
        val rate = computeAchievementRate(snap)
        assertEquals(0.0, rate)
        assertEquals(Rank.E, computeRank(rate, snap.totalNotes))
    }
}
