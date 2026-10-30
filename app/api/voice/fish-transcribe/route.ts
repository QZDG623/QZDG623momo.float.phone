import { NextResponse } from "next/server";
import { proxyFetch } from "@/lib/proxy-fetch";

// Fish Audio 语音识别中转。
// 上游：POST https://api.fish.audio/v1/asr（multipart/form-data，model 走请求头）
// 浏览器同样受 CORS 限制，所以客户端把录音 multipart 发到这里，服务端转发。
export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_FISH_BASE_URL = "https://api.fish.audio";
const DEFAULT_FISH_STT_MODEL = "transcribe-1";
const UPSTREAM_TIMEOUT_MS = 55_000;

function normalizeBaseUrl(value: unknown): string {
    const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_FISH_BASE_URL;
    return raw.replace(/\/+$/, "");
}

function errorMessage(payload: unknown, fallback: string): string {
    if (!payload || typeof payload !== "object") return fallback;
    const record = payload as Record<string, unknown>;
    const message = record.message ?? record.reason ?? record.detail ?? record.error;
    if (typeof message === "string" && message.trim()) return message.trim();
    return fallback;
}

export async function POST(request: Request) {
    const form = await request.formData().catch(() => null);
    if (!form) {
        return NextResponse.json({ error: "invalid_form", message: "请求格式错误" }, { status: 400 });
    }

    const apiKey = typeof form.get("apiKey") === "string" ? String(form.get("apiKey")).trim() : "";
    if (!apiKey) {
        return NextResponse.json({ error: "missing_api_key", message: "Fish Audio API Key 未配置" }, { status: 400 });
    }

    const file = form.get("file");
    if (!(file instanceof Blob) || file.size === 0) {
        return NextResponse.json({ error: "missing_audio", message: "没有录到声音" }, { status: 400 });
    }

    const baseUrl = normalizeBaseUrl(form.get("baseUrl"));
    const rawModel = form.get("model");
    const model = typeof rawModel === "string" && rawModel.trim() ? rawModel.trim() : DEFAULT_FISH_STT_MODEL;
    const rawLanguage = form.get("language");
    const language = typeof rawLanguage === "string" ? rawLanguage.trim() : "";

    // 原生桥给的是 WAV，按住说话给的是 mp4/m4a 或 webm；扩展名跟着真实 MIME 走更稳
    const mime = (file.type || "").toLowerCase();
    const ext = mime.includes("wav") ? "wav"
        : mime.includes("mp4") ? "m4a"
        : mime.includes("ogg") ? "ogg"
        : mime.includes("mpeg") ? "mp3"
        : "webm";
    const upstream = new FormData();
    upstream.set("audio", file, `speech.${ext}`);
    // 只要整段文本，不需要逐字时间戳，能省一点处理时间
    upstream.set("ignore_timestamps", "true");
    if (language) upstream.set("language", language);

    try {
        const response = await proxyFetch(`${baseUrl}/v1/asr`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                model,
            },
            body: upstream,
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });

        const text = await response.text();
        let payload: unknown = null;
        try { payload = JSON.parse(text); } catch { /* 非 JSON */ }

        if (!response.ok) {
            return NextResponse.json(
                { error: "fish_asr_failed", message: errorMessage(payload, text.slice(0, 300) || `HTTP ${response.status}`).slice(0, 500) },
                { status: 502 },
            );
        }

        const transcript = payload && typeof payload === "object"
            ? (payload as Record<string, unknown>).text
            : undefined;
        return NextResponse.json({ ok: true, text: typeof transcript === "string" ? transcript.trim() : "" });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json(
            { error: "fish_asr_failed", message: `Fish Audio 识别失败：${message}`.slice(0, 500) },
            { status: 502 },
        );
    }
}
