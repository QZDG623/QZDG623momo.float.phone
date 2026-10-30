package app.floatphone.shell

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import androidx.core.content.ContextCompat
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.math.sqrt

/**
 * 原生麦克风桥：`window.FloatMic`。
 *
 * 为什么要有它（改之前先读）：
 *  网页侧的 `getUserMedia` 走的是 WebView/Chromium 的音频设备模块，在部分安卓机上
 *  直接起不来（`NotReadableError: Could not start audio source`）——系统权限是好的，
 *  壳的权限桥接也 grant 了，但 Chromium 的 ADM 打不开输入设备，重试多少次都一样。
 *  这里改用原生 `AudioRecord` 采集，完全绕开 WebView 的音频栈。
 *
 * 分工：
 *  - 原生：开麦、按 20ms 一帧读 PCM、算 RMS、做 VAD（切句）、编码 WAV 排队。
 *    阈值/时长这些经验值和网页侧同一套数值，但判断放在原生，避免每秒几十次
 *    跨语言调用。
 *  - 网页：只管三件事——轮询电平做动效、取走切好的 WAV 段送云端识别、
 *    把识别结果发出去。所以调 VAD 参数改这里 + 网页即可，不用动业务代码。
 *
 * 音频格式固定 16kHz / 单声道 / PCM16：语音识别用这个最省流量，WAV 头也简单。
 * 每段上限 20s，超时强制切段，避免一直说导致单段过大、识别超时。
 */
class MicBridge(private val context: Context) {

    companion object {
        private const val SAMPLE_RATE = 16_000
        private const val FRAME_SAMPLES = 320          // 20ms
        private const val MIN_SPEECH_MS = 350L
        private const val SILENCE_MS = 800L
        private const val ATTACK_FRAMES = 3
        private const val MAX_SEGMENT_MS = 20_000L
        private const val PREROLL_FRAMES = 15          // 开口前留 300ms，避免吃掉第一个字
        private const val LEVEL_THRESHOLD = 0.012f

        @Volatile
        private var instance: MicBridge? = null

        /** MainActivity 创建时调用，返回可挂到 WebView 上的桥实例。 */
        fun attach(context: Context): MicBridge {
            val bridge = MicBridge(context.applicationContext)
            instance = bridge
            return bridge
        }

        fun detach() {
            instance?.stop()
            instance = null
        }
    }

    private var record: AudioRecord? = null
    private var thread: Thread? = null

    @Volatile private var active = false
    @Volatile private var muted = false
    @Volatile private var lastLevel = 0.0
    @Volatile private var voiceActive = false
    @Volatile private var errorText = ""

    /** 切好的 WAV（base64），网页侧 takeSegment() 取走一个。 */
    private val segments = ConcurrentLinkedQueue<String>()

    // ── 供网页调用（@JavascriptInterface 跑在 JavaBridge 线程，全部要线程安全）──

    /** 开麦。成功返回空串，失败返回错误原因（网页直接展示）。 */
    @android.webkit.JavascriptInterface
    fun start(): String {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            errorText = "没有录音权限"
            return errorText
        }
        if (active && record != null) return ""

        val minBuf = AudioRecord.getMinBufferSize(
            SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
        )
        if (minBuf <= 0) {
            errorText = "设备不支持 16kHz 录音（minBuffer=$minBuf）"
            return errorText
        }
        val bufBytes = maxOf(minBuf, FRAME_SAMPLES * 2 * 10)

        // VOICE_RECOGNITION 自带降噪/回声消除，最适合识别；个别机型不给就退回 MIC。
        val sources = intArrayOf(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            MediaRecorder.AudioSource.MIC,
        )
        var rec: AudioRecord? = null
        var lastInitError = ""
        for (source in sources) {
            val candidate = try {
                AudioRecord(source, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT, bufBytes)
            } catch (e: Exception) {
                lastInitError = e.message ?: e::class.java.simpleName
                null
            }
            if (candidate != null && candidate.state == AudioRecord.STATE_INITIALIZED) {
                rec = candidate
                break
            }
            candidate?.release()
        }
        if (rec == null) {
            errorText = "AudioRecord 初始化失败（可能被其他应用占用）$lastInitError"
            return errorText
        }
        // startRecording() 是 void：成功与否只能看 recordingState，
        // 失败时它自己会抛 IllegalStateException。
        val started = runCatching { rec.startRecording() }.isSuccess
        if (!started || rec.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
            runCatching { rec.release() }
            errorText = "无法开始录音（设备被占用）"
            return errorText
        }

        record = rec
        errorText = ""
        active = true
        muted = false
        voiceActive = false
        lastLevel = 0.0
        segments.clear()
        thread = Thread({ captureLoop(rec) }, "FloatMic").apply {
            isDaemon = true
            priority = Thread.MAX_PRIORITY
            start()
        }
        return ""
    }

    @android.webkit.JavascriptInterface
    fun stop() {
        active = false
        val t = thread
        thread = null
        t?.join(300)
        val rec = record
        record = null
        runCatching { rec?.stop() }
        runCatching { rec?.release() }
        voiceActive = false
        lastLevel = 0.0
    }

    @android.webkit.JavascriptInterface
    fun setMuted(m: Boolean) {
        // 静音时直接丢弃正在攒的片段：AI 说话期间的残缺音频不该送去识别。
        muted = m
        if (m) voiceActive = false
    }

    /** 当前 RMS 音量 0~1，网页轮询做动效。 */
    @android.webkit.JavascriptInterface
    fun level(): Double = lastLevel

    /** 是否检测到有人在说话（用于 UI 的「正在听」态）。 */
    @android.webkit.JavascriptInterface
    fun isSpeaking(): Boolean = voiceActive

    @android.webkit.JavascriptInterface
    fun running(): Boolean = active

    @android.webkit.JavascriptInterface
    fun lastError(): String = errorText

    /** 取走一段切好的 WAV（base64）；没有则返回空串。 */
    @android.webkit.JavascriptInterface
    fun takeSegment(): String = segments.poll() ?: ""

    @android.webkit.JavascriptInterface
    fun hasSegment(): Boolean = segments.isNotEmpty()

    // ── 采集线程 ─────────────────────────────────────────────

    private fun captureLoop(rec: AudioRecord) {
        val frame = ShortArray(FRAME_SAMPLES)
        // 开口前的预滚：一直保留最近 300ms，判定开口时先补上，免得第一个字被切掉
        val preroll = ArrayDeque<ShortArray>()
        var segment = ArrayList<Short>(FRAME_SAMPLES * 50)
        var speechStartedAt = 0L
        val startedAt = System.nanoTime()
        var lastVoiceAt = 0L
        var attack = 0
        var noiseFloor = 0.004f
        var speakingNow = false

        while (active) {
            val read = rec.read(frame, 0, FRAME_SAMPLES)
            if (read <= 0) {
                if (read < 0) { errorText = "读取麦克风数据失败（$read）"; break }
                continue
            }
            val copy = frame.copyOf(read)
            val nowMs = (System.nanoTime() - startedAt) / 1_000_000

            var sumSq = 0.0
            for (v in copy) { val s = v / 32768.0; sumSq += s * s }
            val rms = sqrt(sumSq / copy.size).toFloat()
            lastLevel = rms.toDouble()

            if (muted) {
                // 静音期间不判句、不攒数据
                if (segment.isNotEmpty()) segment = ArrayList()
                speakingNow = false
                voiceActive = false
                attack = 0
                lastVoiceAt = 0
                continue
            }

            if (!speakingNow && rms < LEVEL_THRESHOLD) {
                noiseFloor = noiseFloor * 0.98f + rms * 0.02f
            }
            val threshold = maxOf(LEVEL_THRESHOLD, noiseFloor * 2.2f)
            val loud = rms >= threshold

            if (!speakingNow) {
                preroll.addLast(copy)
                while (preroll.size > PREROLL_FRAMES) preroll.removeFirst()
                if (loud) {
                    attack += 1
                    if (attack >= ATTACK_FRAMES) {
                        while (preroll.isNotEmpty()) {
                            for (v in preroll.removeFirst()) segment.add(v)
                        }
                        for (v in copy) segment.add(v)
                        attack = 0
                        speakingNow = true
                        speechStartedAt = nowMs
                        lastVoiceAt = nowMs
                        voiceActive = true
                    }
                } else {
                    attack = 0
                }
                continue
            }

            // 正在说话：持续攒数据
            for (v in copy) segment.add(v)
            if (loud) lastVoiceAt = nowMs

            val segMs = nowMs - speechStartedAt
            val tooLong = segMs >= MAX_SEGMENT_MS
            val finished = nowMs - lastVoiceAt >= SILENCE_MS
            if (tooLong || finished) {
                if (segMs >= MIN_SPEECH_MS && segment.isNotEmpty()) {
                    val wav = encodeWav(segment.toShortArray())
                    segments.add(Base64.encodeToString(wav, Base64.NO_WRAP))
                }
                segment = ArrayList(FRAME_SAMPLES * 50)
                speakingNow = false
                voiceActive = false
                attack = 0
                lastVoiceAt = 0
            }
        }
        voiceActive = false
        lastLevel = 0.0
    }

    /** PCM16 单声道 → 44 字节头的 WAV。 */
    private fun encodeWav(pcm: ShortArray): ByteArray {
        val dataSize = pcm.size * 2
        val out = ByteBuffer.allocate(44 + dataSize).order(ByteOrder.LITTLE_ENDIAN)
        out.put("RIFF".toByteArray())
        out.putInt(36 + dataSize)
        out.put("WAVE".toByteArray())
        out.put("fmt ".toByteArray())
        out.putInt(16)
        out.putShort(1.toShort())                          // PCM
        out.putShort(1.toShort())                          // mono
        out.putInt(SAMPLE_RATE)
        out.putInt(SAMPLE_RATE * 2)                        // byteRate
        out.putShort(2.toShort())                          // blockAlign
        out.putShort(16.toShort())                         // bitsPerSample
        out.put("data".toByteArray())
        out.putInt(dataSize)
        for (s in pcm) out.putShort(s)
        return out.array()
    }
}
