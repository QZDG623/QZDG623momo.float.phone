import { NextResponse } from "next/server";
import { proxyFetch } from "@/lib/proxy-fetch";

// Fish Audio 的接口没有开启 CORS（响应里没有 Access-Control-Allow-Origin），
// 浏览器直连会被预检拦下，所以 TTS 统一走这个服务端中转：
// 客户端 POST 文本 → 这里带 Key 直连 api.fish.audio → 把音频字节原样回给客户端。
export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_FISH_BASE_URL = "https://api.fish.audio";
const DEFAULT_FISH_MODEL = "s2.1-pro-free";
const UPSTREAM_TIMEOUT_MS = 55_000;

function normalizeBaseUrl(value: unknown): string {
    const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_FISH_BASE_URL;
    return raw.replace(/\/+$/, "");
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function errorMessage(payload: unknown, fallback: string): string {
    if (!payload || typeof payload !== "object") return fallback;
    const record = payload as Record<string, unknown>;
    const message = record.message ?? record.reason ?? record.detail ?? record.error;
    if (typeof message === "string" && message.trim()) return message.trim();
    if (Array.isArray(message) && message.length) return message.map(String).join("；");
    return fallback;
}

export async function POST(request: Request) {
    const body = await request.json().catch(() => ({} as Record<string, unknown>));
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey) {
        return NextResponse.json({ error: "missing_api_key", message: "Fish Audio API Key 未配置" }, { status: 400 });
    }

    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
        return NextResponse.json({ error: "missing_text", message: "合成文本为空" }, { status: 400 });
    }

    const baseUrl = normalizeBaseUrl(body.baseUrl);
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : DEFAULT_FISH_MODEL;
    const format = typeof body.format === "string" && body.format.trim() ? body.format.trim() : "mp3";
    const voiceId = typeof body.voiceId === "string" ? body.voiceId.trim() : "";

    const payload: Record<string, unknown> = {
        text,
        format,
        normalize: true,
        // 语音通话/回复播报对等待更敏感，用 balanced 折中音质与延迟
        latency: "balanced",
        chunk_length: 300,
    };
    if (voiceId) payload.reference_id = voiceId;
    if (typeof body.speed === "number" && Number.isFinite(body.speed)) {
        payload.prosody = { speed: clamp(body.speed, 0.5, 2), normalize_loudness: true };
    }

    try {
        const response = await proxyFetch(`${baseUrl}/v1/tts`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                model,
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });

        if (!response.ok) {
            const raw = await response.text().catch(() => "");
            let parsed: unknown = null;
            try { parsed = JSON.parse(raw); } catch { /* 非 JSON 错误体 */ }
            const message = errorMessage(parsed, raw || `HTTP ${response.status}`);
            return NextResponse.json(
                { error: "fish_tts_failed", message: message.slice(0, 500) },
                { status: 502 },
            );
        }

        const audio = await response.arrayBuffer();
        if (!audio.byteLength) {
            return NextResponse.json({ error: "empty_audio", message: "Fish Audio 未返回音频数据" }, { status: 502 });
        }
        return new NextResponse(audio, {
            status: 200,
            headers: {
                "Content-Type": format === "wav" ? "audio/wav" : format === "opus" ? "audio/ogg" : "audio/mpeg",
                "Cache-Control": "no-store",
            },
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json(
            { error: "fish_tts_failed", message: `Fish Audio 请求失败：${message}`.slice(0, 500) },
            { status: 502 },
        );
    }
}
