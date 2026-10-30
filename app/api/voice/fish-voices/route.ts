import { NextResponse } from "next/server";
import { proxyFetch } from "@/lib/proxy-fetch";

// 拉取 Fish Audio 音色（Voice Model）列表。
// Fish 的音色接口是 GET https://api.fish.audio/model，
// 返回 { total, items: [{ _id, title, author: { nickname }, ... }] }。
// self=true 取当前 API Key 所属工作区自己创建/克隆的音色；
// 不带 self 取公共音色库的前 N 个（按热度排序）。
export const runtime = "nodejs";
export const maxDuration = 30;

const DEFAULT_FISH_BASE_URL = "https://api.fish.audio";
const UPSTREAM_TIMEOUT_MS = 20_000;
const SELF_PAGE_SIZE = 100;
const PUBLIC_PAGE_SIZE = 60;

type FishVoice = { id: string; name: string; createdAt?: number };

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

function toTime(value: unknown): number | undefined {
    if (typeof value !== "string" || !value) return undefined;
    const ts = Date.parse(value);
    return Number.isFinite(ts) ? ts : undefined;
}

function extractVoices(payload: unknown, prefix?: string): FishVoice[] {
    if (!payload || typeof payload !== "object") return [];
    const items = (payload as Record<string, unknown>).items;
    if (!Array.isArray(items)) return [];
    return items.flatMap(item => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        const id = record._id ?? record.id;
        if (typeof id !== "string" || !id.trim()) return [];
        const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : id.trim();
        const author = (record.author ?? {}) as Record<string, unknown>;
        const nickname = typeof author.nickname === "string" ? author.nickname.trim() : "";
        const suffix = !prefix && nickname ? ` · ${nickname}` : "";
        return [{
            id: id.trim(),
            name: `${prefix || ""}${title}${suffix}`,
            createdAt: toTime(record.created_at),
        }];
    });
}

async function fetchModels(
    baseUrl: string,
    apiKey: string,
    self: boolean,
    pageSize: number,
): Promise<{ ok: true; voices: FishVoice[] } | { ok: false; message: string }> {
    const url = `${baseUrl}/model?page_size=${pageSize}&page_number=1&sort_by=score${self ? "&self=true" : ""}`;
    try {
        const response = await proxyFetch(url, {
            method: "GET",
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        const text = await response.text();
        let payload: unknown = null;
        try { payload = JSON.parse(text); } catch { /* 非 JSON */ }
        if (!response.ok) {
            const message = errorMessage(payload, text.slice(0, 300) || `HTTP ${response.status}`);
            return { ok: false, message: message || `HTTP ${response.status}` };
        }
        return { ok: true, voices: extractVoices(payload, self ? "我的 · " : undefined) };
    } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
}

export async function POST(request: Request) {
    const body = await request.json().catch(() => ({} as Record<string, unknown>));
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey) {
        return NextResponse.json({ error: "missing_api_key", message: "请先填写 Fish Audio API Key" }, { status: 400 });
    }
    const baseUrl = normalizeBaseUrl(body.baseUrl);

    const [own, publicVoices] = await Promise.all([
        fetchModels(baseUrl, apiKey, true, SELF_PAGE_SIZE),
        fetchModels(baseUrl, apiKey, false, PUBLIC_PAGE_SIZE),
    ]);

    if (!own.ok && !publicVoices.ok) {
        return NextResponse.json(
            { error: "list_models_failed", message: (own.message || publicVoices.message).slice(0, 500) },
            { status: 502 },
        );
    }

    const seen = new Set<string>();
    const voices: FishVoice[] = [];
    for (const voice of [
        ...(own.ok ? own.voices : []),
        ...(publicVoices.ok ? publicVoices.voices : []),
    ]) {
        if (seen.has(voice.id)) continue;
        seen.add(voice.id);
        voices.push(voice);
    }

    return NextResponse.json({
        ok: true,
        voices,
        warning: own.ok ? undefined : own.message,
    });
}
