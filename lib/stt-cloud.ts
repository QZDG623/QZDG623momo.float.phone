// lib/stt-cloud.ts — 云端语音识别（按住说话）
//
// 非 iOS 设备的通话不再依赖浏览器 Web Speech API（国内安卓基本不可用，且持续
// 开麦会把整页音频会话钉在通话模式）。改为微信式按住说话：按住用 MediaRecorder
// 录一段音，松手后发给 OpenAI 兼容的 /audio/transcriptions 转文字。麦克风只在
// 按住的几秒内打开，松手立刻释放，不再有音频会话残留问题。
// iOS 保持原有 Web Speech 免提方案（见 tts-service.ts 的会话说明）。

import { loadBindingConfig, loadVoiceConfigs, resolveBinding } from "./settings-storage";
import type { VoiceApiConfig } from "./settings-types";

export type CloudSttConfig = {
    provider: "OpenAI" | "Minimax" | "FishAudio";
    baseUrl: string;
    apiKey: string;
    model: string;
};

const DEFAULT_STT_MODEL = "whisper-1";
const DEFAULT_MINIMAX_STT_MODEL = "asr-1.0";
const DEFAULT_FISH_BASE_URL = "https://api.fish.audio";
const DEFAULT_FISH_STT_MODEL = "transcribe-1";
const TRANSCRIBE_TIMEOUT_MS = 60_000;
// 录音兜底上限：忘记松手/指针事件丢失时自动停，避免无限占用麦克风
const MAX_RECORDING_MS = 60_000;

function toCloudSttConfig(config: VoiceApiConfig | undefined | null): CloudSttConfig | null {
    if (!config) return null;
    if (config.provider !== "OpenAI" && config.provider !== "Minimax" && config.provider !== "FishAudio") return null;
    if (!config.apiKey?.trim()) return null;
    if (config.enableSTT === false) return null;

    const baseUrl = (config.baseUrl || "").trim().replace(/\/+$/, "");
    const apiKey = config.apiKey.trim();

    if (config.provider === "Minimax") {
        return {
            provider: "Minimax",
            baseUrl: baseUrl || "https://api.minimaxi.com/v1",
            apiKey,
            model: config.sttModel?.trim() || DEFAULT_MINIMAX_STT_MODEL,
        };
    }

    if (config.provider === "FishAudio") {
        return {
            provider: "FishAudio",
            baseUrl: baseUrl || DEFAULT_FISH_BASE_URL,
            apiKey,
            model: config.sttModel?.trim() || DEFAULT_FISH_STT_MODEL,
        };
    }

    return {
        provider: "OpenAI",
        baseUrl: baseUrl || "https://api.openai.com/v1",
        apiKey,
        model: config.sttModel?.trim() || DEFAULT_STT_MODEL,
    };
}

/**
 * 列出所有可用的云端识别配置（角色绑定优先），用于一个失败时自动换下一个
 * （典型场景：MiniMax 余额不足 402，但账户里还配了 Fish Audio / OpenAI）。
 */
export function listCloudSttConfigs(characterId?: string): CloudSttConfig[] {
    const configs = loadVoiceConfigs();
    const out: CloudSttConfig[] = [];
    const push = (cloud: CloudSttConfig | null) => {
        if (!cloud) return;
        const duplicate = out.some(c => c.provider === cloud.provider
            && c.baseUrl === cloud.baseUrl
            && c.apiKey === cloud.apiKey
            && c.model === cloud.model);
        if (!duplicate) out.push(cloud);
    };
    // 方案显式指定了「识别改用别的方案」时，先试被指定的那个
    const linked = (config: VoiceApiConfig | undefined | null) => {
        if (!config?.sttConfigId || config.sttConfigId === config.id) return undefined;
        return configs.find(c => c.id === config.sttConfigId);
    };

    if (characterId) {
        const bindings = loadBindingConfig();
        const slot = resolveBinding(bindings, characterId, "chat");
        const bound = configs.find(c => c.id === slot.voiceConfigId);
        push(toCloudSttConfig(linked(bound)));
        push(toCloudSttConfig(bound));
    }
    for (const config of configs) {
        push(toCloudSttConfig(linked(config)));
        push(toCloudSttConfig(config));
    }
    return out;
}

/**
 * 解析可用的云端识别配置：优先角色绑定的语音配置（须启用 STT），
 * 否则取第一个满足条件的语音配置。没有则返回 null（通话回落到文字输入）。
 */
export function resolveCloudSttConfig(characterId?: string): CloudSttConfig | null {
    return listCloudSttConfigs(characterId)[0] ?? null;
}

/**
 * 壳注入的原生麦克风桥（window.FloatMic，见 android-shell/MicBridge.kt）。
 *
 * 为什么需要它：WebView 的 getUserMedia 在部分安卓机上直接
 * `NotReadableError: Could not start audio source`——系统权限与壳的权限桥接都没问题，
 * 是 Chromium 的音频设备模块打不开输入源，重试也没用。原生 AudioRecord 绕开整层，
 * 直接在壳里采集并把切好的 WAV 交回来。
 */
type NativeMicBridge = {
    /** 成功返回空串，失败返回错误原因 */
    start: () => string;
    stop: () => void;
    setMuted: (m: boolean) => void;
    level: () => number;
    isSpeaking: () => boolean;
    running: () => boolean;
    lastError: () => string;
    takeSegment: () => string;
};

export function nativeMicAvailable(): boolean {
    return typeof window !== "undefined" && !!(window as unknown as { FloatMic?: NativeMicBridge }).FloatMic;
}

export function isCallRecordingSupported(): boolean {
    if (nativeMicAvailable()) return true;
    return typeof navigator !== "undefined"
        && !!navigator.mediaDevices?.getUserMedia
        && typeof MediaRecorder !== "undefined";
}

export type ActiveCallRecording = {
    /** 松手：停止录音并返回音频（没录到内容返回 null）。 */
    stop: () => Promise<Blob | null>;
    /** 取消：丢弃已录内容，立即释放麦克风。 */
    cancel: () => void;
};

/** 按下开始录音。resolve 时麦克风已经在录；权限被拒等失败会 reject。 */
export async function startCallRecording(): Promise<ActiveCallRecording> {
    if (!isCallRecordingSupported()) throw new Error("当前环境不支持录音");

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {
        throw new Error("麦克风权限被拒绝或不可用");
    });

    // 优先 mp4(aac)：OpenAI whisper 与 MiniMax asr-1.0 都支持；
    // webm(opus) 仅 OpenAI 认，MiniMax 不认 webm 容器。
    const mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg"]
        .find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } });
    const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32_000 })
        : new MediaRecorder(stream);

    const chunks: Blob[] = [];
    let finished = false;
    let cancelled = false;
    let resolveStop: ((blob: Blob | null) => void) | null = null;

    const releaseMic = () => {
        try { stream.getTracks().forEach(track => track.stop()); } catch { /* ignore */ }
    };

    recorder.ondataavailable = event => {
        if (event.data && event.data.size) chunks.push(event.data);
    };
    recorder.onstop = () => {
        if (finished) return;
        finished = true;
        window.clearTimeout(maxTimer);
        releaseMic();
        if (cancelled) { resolveStop?.(null); return; }
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        resolveStop?.(blob.size > 0 ? blob : null);
    };
    recorder.onerror = () => {
        if (finished) return;
        finished = true;
        window.clearTimeout(maxTimer);
        releaseMic();
        resolveStop?.(null);
    };

    const maxTimer = window.setTimeout(() => {
        try { recorder.stop(); } catch { /* ignore */ }
    }, MAX_RECORDING_MS);

    recorder.start();

    return {
        stop: () => new Promise<Blob | null>(resolve => {
            resolveStop = resolve;
            if (finished) { resolve(null); return; }
            try { recorder.stop(); } catch { recorder.onstop?.(new Event("stop") as never); }
        }),
        cancel: () => {
            cancelled = true;
            if (finished) return;
            try { recorder.stop(); } catch {
                finished = true;
                window.clearTimeout(maxTimer);
                releaseMic();
            }
        },
    };
}

// ── 连续监听（免提通话）────────────────────────────────
//
// 非 iOS 的通话里，原先只有「按住说话」——按一下录一段、松手才识别。用户要的是
// 真·电话那种：进了语音模式就一直听，说完一句自动识别发出去。这里实现一个
// 基于音量（RMS）的语音活动检测（VAD）：
//   - 麦克风常开，AnalyserNode 实时算 RMS；
//   - 音量超过阈值 → 判定为开始说话，启动 MediaRecorder 录这一段；
//   - 音量掉到阈值以下并持续 silenceMs → 判定一句话说完，停录、把这段音频
//     回调出去给上层转写；
//   - 回到「待命」，继续等下一句。
//
// 这样一句一句地切，每段几秒到十几秒，转写接口压力小、延迟也低。静音期间不
// 录音，麦克风虽然开着但不产生数据。

export type ContinuousVoiceCallbacks = {
    /** 检测到开口（音量越过阈值） */
    onSpeechStart?: () => void;
    /** 一句话说完，回调这段音频 */
    onSegment: (blob: Blob) => void;
    /** 出错（麦克风权限、录音失败等） */
    onError: (message: string) => void;
    /** 实时音量 0~1，UI 可用来做波形/动效 */
    onLevel?: (level: number) => void;
};

export type ContinuousVoiceSession = {
    /** 彻底停止，释放麦克风 */
    stop: () => void;
    /** 静音/取消静音：静音时不录音也不切段，但麦克风保持打开 */
    setMuted: (muted: boolean) => void;
};

const DEFAULT_VAD = {
    levelThreshold: 0.012,   // RMS 阈值下限（实际阈值还会按环境噪声自适应抬高）
    minSpeechMs: 350,        // 短于此视为误触丢弃
    silenceMs: 800,          // 停顿多久算一句说完
    attackFrames: 3,         // 连续几帧超阈值才算开口（抗爆音）
};

/**
 * 申请麦克风。
 *
 * 注意：不要传 echoCancellation/noiseSuppression 这类处理约束——部分安卓 WebView
 * 会以 OverconstrainedError 拒绝，且紧接着的第二次申请还会被壳里的权限桥接当成
 * 「已有请求在途」而 deny，最终表现就是「系统权限明明开着却报权限被拒绝」。
 * 这里只申请 audio: true（与 1.0.25 实测可用的写法一致），并把真实错误名带出去，
 * 同时对设备忙（NotReadableError/AbortError）做短暂重试。
 */
async function openMic(): Promise<MediaStream> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) {
            lastErr = e;
            const name = (e as DOMException)?.name || "";
            if (name === "NotAllowedError" || name === "SecurityError") break;
            // 设备被占用/音频焦点未释放时等一会儿再试
            await new Promise(r => setTimeout(r, 350));
        }
    }
    const name = (lastErr as DOMException)?.name || "UnknownError";
    const detail = (lastErr as Error)?.message || "";
    if (name === "NotAllowedError" || name === "SecurityError") {
        throw new Error("麦克风权限被拒绝或不可用");
    }
    throw new Error(`麦克风打开失败（${name}${detail ? `: ${detail}` : ""}）`);
}

/** base64 → Blob（原生交回来的 WAV 段） */
function base64ToBlob(b64: string, type: string): Blob {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
}

/**
 * 走原生 AudioRecord 的连续监听。VAD 与切句都在 Kotlin 里做
 * （见 MicBridge.kt），网页只轮询电平、取走 WAV 段。
 */
function startNativeContinuousVoice(callbacks: ContinuousVoiceCallbacks): ContinuousVoiceSession {
    const mic = (window as unknown as { FloatMic: NativeMicBridge }).FloatMic;
    const err = mic.start();
    if (err) throw new Error(`麦克风打开失败（${err}）`);

    let stopped = false;
    let wasSpeaking = false;
    let lastLevelAt = 0;

    // 电平轮询 ~12fps：够做动效，又不会把渲染线程压满
    const levelTimer = window.setInterval(() => {
        if (stopped) return;
        const now = performance.now();
        if (now - lastLevelAt < 80) return;
        lastLevelAt = now;
        // 原生给的是原始 RMS（说话约 0.03~0.25），放大到 0~1 便于 UI 显示
        callbacks.onLevel?.(Math.min(1, Number(mic.level() || 0) * 4));
        const speaking = !!mic.isSpeaking();
        if (speaking && !wasSpeaking) callbacks.onSpeechStart?.();
        wasSpeaking = speaking;
    }, 80);

    // 取段轮询：原生切完一句就排队，这里取走送识别
    const segmentTimer = window.setInterval(() => {
        if (stopped) return;
        const b64 = mic.takeSegment();
        if (b64) callbacks.onSegment(base64ToBlob(b64, "audio/wav"));
    }, 120);

    return {
        stop: () => {
            if (stopped) return;
            stopped = true;
            window.clearInterval(levelTimer);
            window.clearInterval(segmentTimer);
            mic.setMuted(true);
            mic.stop();
        },
        setMuted: (m: boolean) => { if (!stopped) mic.setMuted(m); },
    };
}

export async function startContinuousVoice(
    callbacks: ContinuousVoiceCallbacks,
    vad: Partial<typeof DEFAULT_VAD> = {},
): Promise<ContinuousVoiceSession> {
    // 壳里就用原生录音：WebView 的音频采集在部分机型上直接起不来。
    if (nativeMicAvailable()) return startNativeContinuousVoice(callbacks);
    if (!isCallRecordingSupported()) throw new Error("当前环境不支持录音");
    const cfg = { ...DEFAULT_VAD, ...vad };

    const stream = await openMic();

    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    const audioCtx: AudioContext = new AudioCtx();
    // 关键：安卓 WebView 里新建的 AudioContext 常是 suspended，AnalyserNode 会一直
    // 返回静音波形（全 128）→ RMS 恒为 0 → VAD 永远不触发、一句话也录不到。
    // 必须显式 resume，并在前几秒持续兜底（个别机型要等音频焦点释放才可恢复）。
    const ensureRunning = () => {
        if (audioCtx.state === "suspended") void audioCtx.resume().catch(() => {});
    };
    ensureRunning();
    const resumeTimer = window.setInterval(ensureRunning, 400);
    const stopResumeTimer = window.setTimeout(() => window.clearInterval(resumeTimer), 6000);
    // 页面首次触摸也尝试恢复（部分 WebView 要求 resume 发生在用户手势里）
    window.addEventListener("pointerdown", ensureRunning, true);

    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.4;
    source.connect(analyser);
    const timeData = new Uint8Array(analyser.fftSize);

    const pickMime = () =>
        ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg"]
            .find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } });

    let recorder: MediaRecorder | null = null;
    let chunks: Blob[] = [];
    let recStartTs = 0;
    let muted = false;
    let stopped = false;
    let state: "idle" | "speaking" = "idle";
    let lastSpeechAt = 0;
    let attackCount = 0;
    let rafId = 0;
    // 环境噪声底噪（自适应）：安静时缓慢跟随，阈值取「底噪 × 2.2」与下限的较大值，
    // 避免不同机型麦克风增益差异导致要么一直误触发、要么永远听不到。
    let noiseFloor = 0.004;

    const releaseMic = () => {
        window.clearInterval(resumeTimer);
        window.clearTimeout(stopResumeTimer);
        window.removeEventListener("pointerdown", ensureRunning, true);
        try { stream.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
        try { audioCtx.close().catch(() => {}); } catch { /* ignore */ }
    };

    const startRecorder = () => {
        chunks = [];
        const mime = pickMime();
        try {
            recorder = mime
                ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32_000 })
                : new MediaRecorder(stream);
        } catch {
            recorder = new MediaRecorder(stream);
        }
        recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
        recorder.onerror = () => {
            recorder = null;
            chunks = [];
            callbacks.onError("录音失败，请重试");
        };
        recorder.start();
        recStartTs = performance.now();
    };

    const flushSegment = () => {
        const r = recorder;
        recorder = null;
        if (!r) return;
        const onstop = () => {
            const blob = new Blob(chunks, { type: r.mimeType || "audio/webm" });
            chunks = [];
            const dur = performance.now() - recStartTs;
            if (blob.size > 0 && dur >= cfg.minSpeechMs) {
                callbacks.onSegment(blob);
            }
        };
        try {
            r.onstop = onstop;
            r.stop();
        } catch {
            onstop();
        }
    };

    const loop = () => {
        if (stopped) return;
        rafId = requestAnimationFrame(loop);
        analyser.getByteTimeDomainData(timeData);
        let sum = 0;
        for (let i = 0; i < timeData.length; i++) {
            const v = (timeData[i] - 128) / 128;
            sum += v * v;
        }
        const rms = Math.sqrt(sum / timeData.length);
        callbacks.onLevel?.(rms);

        if (muted) {
            if (state === "speaking") { state = "idle"; flushSegment(); }
            return;
        }

        const now = performance.now();
        // 自适应阈值：安静时底噪缓慢跟随（只在 idle 且明显低于阈值时更新）
        if (state === "idle" && rms < cfg.levelThreshold) {
            noiseFloor = noiseFloor * 0.98 + rms * 0.02;
        }
        const threshold = Math.max(cfg.levelThreshold, noiseFloor * 2.2);
        const isLoud = rms >= threshold;

        if (state === "idle") {
            if (isLoud) {
                attackCount += 1;
                if (attackCount >= cfg.attackFrames) {
                    attackCount = 0;
                    state = "speaking";
                    lastSpeechAt = now;
                    callbacks.onSpeechStart?.();
                    startRecorder();
                }
            } else {
                attackCount = 0;
            }
        } else {
            if (isLoud) {
                lastSpeechAt = now;
            } else if (now - lastSpeechAt >= cfg.silenceMs) {
                state = "idle";
                flushSegment();
            }
        }
    };

    loop();

    return {
        stop: () => {
            if (stopped) return;
            stopped = true;
            cancelAnimationFrame(rafId);
            if (state === "speaking") flushSegment();
            releaseMic();
        },
        setMuted: (m: boolean) => { muted = m; },
    };
}

/** 调云端语音识别把录音转文字。OpenAI 走 /audio/transcriptions，MiniMax 走 /speech_to_text，
 *  Fish Audio 走服务端中转 /api/voice/fish-transcribe（上游 /v1/asr）。 */
export async function transcribeAudioBlob(blob: Blob, config: CloudSttConfig): Promise<string> {
    const type = (blob.type || "").toLowerCase();
    const isMinimax = config.provider === "Minimax";
    const isFish = config.provider === "FishAudio";
    // MiniMax 认 wav/aiff/flac/m4a(mp4 容器)/mp3/aac/opus/ogg，不认 webm 容器；
    // MediaRecorder 产出的 audio/mp4 就是 m4a，扩展名按 m4a 传更稳。
    const ext = type.includes("mp4") ? (isMinimax || isFish ? "m4a" : "mp4")
        : type.includes("ogg") ? "ogg"
        : type.includes("wav") ? "wav"
        : type.includes("mp3") ? "mp3"
        : "webm";

    if (isFish) {
        // Key 与接口地址放在表单里，由同源服务端转发（Fish 没开 CORS）。
        const fishForm = new FormData();
        fishForm.set("apiKey", config.apiKey);
        fishForm.set("baseUrl", config.baseUrl);
        fishForm.set("model", config.model);
        fishForm.set("file", blob, `speech.${ext}`);
        return await requestTranscript("/api/voice/fish-transcribe", fishForm);
    }

    const form = new FormData();
    form.set("model", config.model);
    if (isMinimax) form.set("response_format", "json");
    form.set("file", blob, `speech.${ext}`);

    // MiniMax 用 /speech_to_text，OpenAI 兼容用 /audio/transcriptions
    const endpoint = isMinimax
        ? `${config.baseUrl}/speech_to_text`
        : `${config.baseUrl}/audio/transcriptions`;

    return await requestTranscript(endpoint, form, {
        Authorization: `Bearer ${config.apiKey}`,
    });
}

/** 统一的识别请求 + JSON 解析（MiniMax / OpenAI 直连，Fish 走中转）。 */
async function requestTranscript(url: string, body: FormData, headers?: Record<string, string>): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: "POST",
            ...(headers ? { headers } : {}),
            body,
            signal: controller.signal,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            // Fish 中转返回 { error, message }，优先把 message 抛出来
            let message = "";
            try {
                const parsed = JSON.parse(text) as { message?: unknown };
                if (typeof parsed.message === "string") message = parsed.message;
            } catch { /* 非 JSON */ }
            // Fish 的原始英文报错太长，且关键是「识别要单独充值」，直接换成可操作的中文提示
            if (/insufficient api credit/i.test(message)) {
                message = "Fish Audio 识别额度不足（识别按小时单独计费）：请在 fish.audio 后台充值 API 额度，"
                    + "或在语音方案里把「识别方案」改为 MiniMax/OpenAI 方案";
            } else if (/invalid token/i.test(message)) {
                message = "Fish Audio API Key 无效，请检查后重新填写";
            }
            throw new Error(`语音识别 API 错误 ${res.status}: ${(message || text).slice(0, 200)}`);
        }
        const contentType = (res.headers.get("content-type") || "").toLowerCase();
        if (contentType.includes("json")) {
            const data = await res.json() as Record<string, unknown>;
            // 不同中转/版本的 JSON 结构不一样：MiniMax 可能把结果放在 data/result 里，
            // 也可能平铺在顶层。三种都试一遍，别因为层级差异就当成「没识别到」。
            const fromText = (node: unknown): string => {
                if (!node || typeof node !== "object") return "";
                const value = (node as { text?: unknown }).text;
                return typeof value === "string" ? value.trim() : "";
            };
            const text = fromText(data)
                || fromText(data.data)
                || fromText(data.result)
                || "";
            return text;
        }
        // response_format=text 风格的中转直接回纯文本
        return (await res.text()).trim();
    } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
            throw new Error(`语音识别超时（超过 ${Math.round(TRANSCRIBE_TIMEOUT_MS / 1000)} 秒无响应）`);
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

/** 依次尝试所有可用识别配置（角色绑定优先），前一个失败自动换下一个。 */
export async function transcribeAudioBlobWithFallback(blob: Blob, characterId?: string): Promise<string> {
    const configs = listCloudSttConfigs(characterId);
    if (!configs.length) throw new Error("未找到可用的语音识别配置");
    let lastError: unknown = null;
    for (const config of configs) {
        try {
            const text = await transcribeAudioBlob(blob, config);
            if (text.trim()) return text;
        } catch (e) {
            lastError = e;
        }
    }
    if (lastError) throw lastError instanceof Error ? lastError : new Error(String(lastError));
    return "";
}
