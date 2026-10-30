// lib/tts-service.ts — 语音合成服务

import type { VoiceApiConfig, ContentAppId } from "./settings-types";
import { loadVoiceConfigs, loadBindingConfig, resolveBinding } from "./settings-storage";

export type VoiceApiConfigResolved = VoiceApiConfig;

/**
 * Resolve the TTS voice config for a character via the binding cascade.
 * Returns null if no voice config is bound or found.
 */
export function resolveVoiceConfig(characterId: string, appId?: ContentAppId): VoiceApiConfig | null {
    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, appId ?? "chat");
    const configs = loadVoiceConfigs();
    if (slot.voiceConfigId) {
        const bound = configs.find(c => c.id === slot.voiceConfigId);
        return bound?.enableTTS === false ? null : bound || null;
    }

    // 只有一个启用的方案时自动兜底，避免“设置页试听成功、聊天却提示未绑定”。
    // 多个方案仍要求用户显式绑定，防止角色误用其他人的音色。
    const enabledConfigs = configs.filter(config => config.enableTTS !== false);
    return enabledConfigs.length === 1 ? enabledConfigs[0] : null;
}

/**
 * Synthesize speech from text using the given voice config.
 * Returns an audio Blob (mp3/wav) or null if synthesis failed.
 *
 * Supported providers:
 * - Minimax: REST API → hex-encoded mp3
 * - OpenAI: REST API → binary audio blob
 * - FishAudio: 经服务端中转 /api/voice/fish-tts → 二进制音频
 */
export async function synthesizeSpeech(
    text: string,
    voiceConfig: VoiceApiConfig,
    options?: { emotion?: string },
): Promise<Blob | null> {
    if (!text.trim()) return null;

    const provider = voiceConfig.provider;

    if (provider === "Minimax") {
        // 只念台词：先剥离 HTML/CSS 与旁白，并保留世界书的 (breath) 等 Sound Tag。
        // dropLatin 必须为 false —— 台词正文里的英文要照常念出来。
        const speechText = sanitizeSpeechText(text, { keepSoundTags: true, dropLatin: false });
        if (!speechText) return null;
        // 只写了 (breath)/(sighs) 之类表演标记、没有一句台词的消息不算台词
        // （聊天显示层已把这类消息整条隐藏），不该合成出一段没有人话的音频。
        if (!hasSpeakableContent(speechText)) return null;
        // 角色自己没写呼吸标记时补上——匀速念完是"AI 腔"的主要来源。
        const performed = addMinimaxBreathMarks(speechText);
        // 调用方显式给了情绪就用它，否则按台词里的标签/关键词推断。
        // 情绪必须在"标签还在"的时候推断，转换后就只剩停顿标记了。
        const emotion = options?.emotion?.trim() || inferMinimaxEmotion(performed) || undefined;
        // 关键：括号内一律不得进 MiniMax TTS。
        // MiniMax speech-01 对 <#x#> 停顿标记不认、对括号 Sound Tag 也只在部分
        // 账号/模型上认，所以 Sound Tag → <#x#> 这条路走不通。终极策略：所有括号
        // 整块删掉；MiniMax 官方 Sound Tag 换成中文标点让 MiniMax 自然断句产生
        // 换气/停顿的活人感。用户自定义的动作括号直接删掉。
        const finalText = stripBracketsWithPunctuation(performed);
        if (!hasSpeakableContent(finalText)) return null;
        return synthesizeMinimax(finalText, voiceConfig, emotion);
    }

    if (provider === "OpenAI") {
        // OpenAI TTS 不认 Sound Tag，会把标签当文本念出来，所以一并清掉；
        // 它也没有情绪参数，纯英文角色要能正常发声，故保留英文。
        const speechText = sanitizeSpeechText(text, { keepSoundTags: false, dropLatin: false });
        if (!speechText) return null;
        return synthesizeOpenAI(speechText, voiceConfig);
    }

    if (provider === "FishAudio") {
        // 括号里的表演标记（(breath)/(sighs) 等）各家模型支持程度不一，
        // Fish 不保证识别，直接清掉，避免被当成英文字念出来。台词里的英文照常保留。
        const speechText = sanitizeSpeechText(text, { keepSoundTags: false, dropLatin: false });
        if (!speechText) return null;
        if (!hasSpeakableContent(speechText)) return null;
        return synthesizeFishAudio(speechText, voiceConfig);
    }

    if (provider === "FishAudio" || provider === "ElevenLabs") {
        return synthesizeExternalVoice(text, voiceConfig);
    }

    return null;
}

async function synthesizeExternalVoice(text: string, config: VoiceApiConfig): Promise<Blob | null> {
    if (!config.apiKey) throw new Error(`${config.provider} API Key 未配置`);
    if (!config.defaultVoice.trim()) throw new Error(`${config.provider} Voice ID 未配置`);
    const response = await fetchWithTimeout("/api/voice/synthesize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            provider: config.provider,
            apiKey: config.apiKey,
            text,
            voiceId: config.defaultVoice,
            model: config.model,
            speechSpeed: config.speechSpeed,
        }),
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { message?: string; error?: string };
        throw new Error(data.message || data.error || `${config.provider} API 请求失败 (${response.status})`);
    }
    const blob = await response.blob();
    return new Blob([await blob.arrayBuffer()], { type: response.headers.get("content-type") || "audio/mpeg" });
}

// A stalled TTS request (TCP connected but no response — cold start, rate-limit
// hold, network blip) would otherwise hang forever, since fetch has no default
// timeout. That froze voice/video calls at "对方正在说话..." until the user
// toggled the mic. Abort after a ceiling so the caller can recover.
const TTS_TIMEOUT_MS = 120_000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = TTS_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
            throw new Error(`语音合成超时（超过 ${Math.round(timeoutMs / 1000)} 秒无响应）`);
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

// ── Minimax TTS ─────────────────────────────────────

// MiniMax voice_setting.emotion 支持的取值（speech-01-turbo/hd、speech-02-turbo/hd 等）。
const MINIMAX_EMOTIONS = new Set([
    "happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm", "neutral", "fluent",
]);

const MINIMAX_SPEED_MIN = 0.5;
const MINIMAX_SPEED_MAX = 2.0;
const MINIMAX_PITCH_MIN = -12;
const MINIMAX_PITCH_MAX = 12;

function normalizeMinimaxSpeed(speed: number | undefined): number {
    if (typeof speed !== "number" || !Number.isFinite(speed)) return 1.0;
    return Math.min(MINIMAX_SPEED_MAX, Math.max(MINIMAX_SPEED_MIN, speed));
}

function normalizeMinimaxPitch(pitch: number | undefined): number {
    if (typeof pitch !== "number" || !Number.isFinite(pitch)) return 0;
    return Math.min(MINIMAX_PITCH_MAX, Math.max(MINIMAX_PITCH_MIN, Math.round(pitch)));
}

// ── 朗读文本清洗（只念台词） ─────────────────────────
// 消息正文里混着渲染用的 HTML/CSS 与旁白，例如
//   [月薪喵擦汗<span style="background: rgba(0,0,0,0.05); color: #888888; …"> (不经意秀腹肌) </span>]
// 以前是把整段原样透传给 MiniMax，于是 style 属性里的整串 CSS 英文、以及括号里的
// 旁白动作都被当成台词念了出来。这里在合成前统一剥离，只留下真正要说的话。

/** MiniMax 官方 Sound Tag（语音世界书 §7.1）。它们是"表演指令"，绝不能当台词念，
 *  但必须原样交给模型，模型才会把它演绎成呼吸/停顿/笑意——这正是"活人感"的来源。 */
const MINIMAX_SOUND_TAGS = [
    "laughs", "chuckle", "coughs", "clear-throat", "groans", "breath", "pant",
    "inhale", "exhale", "gasp", "sniffs", "sighs", "snorts", "burps",
    "lip-smacking", "humming", "hissing", "emm", "sneezes",
];

const MINIMAX_SOUND_TAG_RE = new RegExp(`\\(\\s*(${MINIMAX_SOUND_TAGS.join("|")})\\s*\\)`, "gi");

/**
 * 官方 Sound Tag → MiniMax 停顿标记 <#x#>（单位：秒）映射。
 *
 * 背景：世界书 §7.1 把 (breath)/(sighs)/(chuckle) 等定义为"表演指令"，模型本该
 * 把它们演绎成呼吸/笑意而非字音。但实测部分账号/模型版本不再识别括号标签，会把
 * "breath" 当英文单词念出来（用户截图：语音条 label 直接是 "(breath) 再不起床…"）。
 * 唯一可靠的兜底是把所有括号标签换成 MiniMax 官方支持的 <#x#> 停顿标记——
 * 既不会被念成字音，又在语义边界留下真人换气的留白，保住"活人感"。
 *
 * 映射原则：
 *  - 呼吸类（breath/inhale/exhale/pant）→ 中等停顿，模拟换气
 *  - 叹气/呻吟（sighs/groans）→ 较长停顿，带情绪拖腔
 *  - 吸气/喷鼻（gasp/snorts）→ 短促停顿
 *  - 笑声/清嗓/咳嗽（laughs/chuckle/coughs/clear-throat）→ 短停顿，情绪由 emotion 参数兜底
 *  - 其余 → 短停顿或直接抹掉，绝不让标签变成字音
 */
const MINIMAX_SOUND_TAG_TO_PAUSE: Record<string, string> = {
    breath: "<#0.3#>",
    inhale: "<#0.3#>",
    exhale: "<#0.3#>",
    pant: "<#0.25#>",
    gasp: "<#0.15#>",
    sighs: "<#0.5#>",
    sniffs: "<#0.2#>",
    laughs: "<#0.2#>",
    chuckle: "<#0.2#>",
    coughs: "<#0.2#>",
    "clear-throat": "<#0.2#>",
    groans: "<#0.3#>",
    snorts: "<#0.15#>",
    burps: "<#0.2#>",
    "lip-smacking": "<#0.1#>",
    humming: "<#0.3#>",
    hissing: "<#0.2#>",
    emm: "<#0.2#>",
    sneezes: "<#0.3#>",
};

/**
 * 把台词里所有 MiniMax 官方 Sound Tag 替换成 <#x#> 停顿标记。
 * 必须在 addMinimaxBreathMarks / inferMinimaxEmotion 之后、发送给 MiniMax 之前调用：
 * 前两者依赖标签做情绪推断与补呼吸标记，这里再统一抹成停顿，避免被模型当英文念出。
 */
function soundTagsToPauses(text: string): string {
    return text.replace(MINIMAX_SOUND_TAG_RE, (_, tag: string) => {
        return MINIMAX_SOUND_TAG_TO_PAUSE[tag.toLowerCase()] || "";
    });
}

/**
 * 最后一道保险：中文台词里绝不允许出现任何括号。
 *
 * 为什么还要这一层：Sound Tag 的写法并不总能穷举——模型可能写成 (breaths)、
 * (deep breath)、(Breathing slowly)、(sigh)… 只要漏掉一个，MiniMax 就会把那个
 * 英文单词原样念出来（用户反复反馈的 "(breath)" 音）。与其在标签表上逐个打补丁，
 * 不如立一条不变量：**送进 TTS 的文本里不允许有任何括号字符**。
 *
 * 注意这里【不】清理台词正文里的英文：用户明确要求台词里的英文照常念出来
 * （"OK，我知道了" 里的 OK 必须念），只有括号里的内容不许念。
 */
function stripBracketsWithPunctuation(text: string): string {
    if (!text) return "";
    // 1. MiniMax 官方 Sound Tag → 中文标点（保留呼吸感但不用括号）
    //    叹气/呻吟 → 省略号（情绪拖腔），吸气/喷鼻 → 逗号（短促停顿），
    //    其他表演标签（breath/pant/inhale/exhale/laughs/chuckle/coughs/groans）
    //    → 逗号（换气/短促停顿），情绪由 emotion 参数兜底。
    let out = text.replace(MINIMAX_SOUND_TAG_RE, (_, tag: string) => {
        const t = tag.toLowerCase();
        if (["sighs", "groans"].includes(t)) return "……";
        return "，";
    });

    // 2. 所有括号整块删掉（圆括号/方括号/中文方括号/书名号/花括号）
    out = out
        .replace(/[（(][^）)]*[）)]/g, " ")
        .replace(/\[[^\]]*\]/g, " ")
        .replace(/【[^】]*】/g, " ")
        .replace(/《[^》]*》/g, " ")
        .replace(/〈[^〉]*〉/g, " ")
        .replace(/\{[^}]*\}/g, " ");

    // 3. 兜底：任何剩余括号字符（残缺配对）全部删掉
    out = out.replace(/[（）()【】《》〈〉\[\]{}]/g, " ");

    // 4. 折叠空白 & 标点规范化（台词正文里的英文原样保留，照常念出来）
    out = out
        .replace(/[ \t]{2,}/g, " ")
        .replace(/ ?\n ?/g, "\n")
        .replace(/[ \t]+([，。！？、；：…])/g, "$1")
        .replace(/(，\s*){2,}/g, "，")
        .replace(/(…\s*){2,}/g, "……")
        // 括号换来的逗号如果紧跟在句末标点后面就是多余的（"小笨蛋。，" → "小笨蛋。"）
        .replace(/([。！？…])\s*[，、；：]+/g, "$1")
        .replace(/[，、；：]+\s*([。！？])/g, "$1")
        // 括号删掉后在句首/句尾留下的孤立逗号一并去掉
        .replace(/^[，、；：\s]+/, "")
        .replace(/[，、；：\s]+$/, "")
        .trim();
    return out;
}

/**
 * 一条消息正文 → 最终要送给 MiniMax 念的文本。
 *
 * 单一出口，保证"语音条里存的文本"与"真正被念出来的文本"完全一致：
 * 清洗（只留台词）→ 补呼吸停顿 → Sound Tag 转 <#x#> 停顿 → 抹掉残留英文。
 * 调用方（语音条、通话、VN、故事、微信）都从这里取文本，避免各处各写一套。
 */
export function toMinimaxSpeakText(raw: string): string {
    const speechText = sanitizeSpeechText(raw, { keepSoundTags: true, dropLatin: false });
    if (!speechText) return "";
    if (!hasSpeakableContent(speechText)) return "";
    return stripBracketsWithPunctuation(addMinimaxBreathMarks(speechText));
}

/**
 * 语音世界书 §7.2 非官方/不适配标签替换表。
 *
 * speech-2.8 只认官方标签，其余会被模型当普通文本念出来（世界书叫"掉格式"）。
 * 以前这些标签连同括号一起被删掉，表演直接丢失；现在按世界书的规则换成官方组合，
 * 既不出字音、也保住"耳语/哽咽/打哈欠"该有的呼吸与语气。
 * 顺序无所谓：全部先替换成官方形式，随后统一交给官方标签占位符保管。
 */
const MINIMAX_NONOFFICIAL_TAGS: Array<[RegExp, string]> = [
    [/\(\s*(?:whispers?|耳语|气声)\s*\)/gi, "(breath)"],
    [/\(\s*(?:low|[，,]?\s*unhurried|急促|低沉)\s*\)/gi, "(pant) (breath)"],
    [/\(\s*(?:crying|cries|哭泣|哭腔)\s*\)/gi, "(sniffs) (breath)"],
    [/\(\s*(?:yawns?|哈欠)\s*\)/gi, "(sighs) (breath)"],
    [/\(\s*(?:clears?\s*-?\s*throat|清嗓)\s*\)/gi, "(clear-throat)"],
    [/\(\s*(?:gasps|倒吸气)\s*\)/gi, "(gasp)"],
    [/\(\s*(?:sniffle|sniffles|吸鼻)\s*\)/gi, "(sniffs)"],
    [/\(\s*(?:laugh|大笑)\s*\)/gi, "(laughs)"],
    [/\(\s*(?:chuckles|轻笑)\s*\)/gi, "(chuckle)"],
    // §7.2-04：口哨没有对应标签，直接写成文本让模型自然演绎
    [/\(\s*whistles?\s*\)/gi, "吹了声口哨"],
];

/** 中文（含扩展区）——用来判断"这条消息是不是在用中文说话"。 */
const HAS_CHINESE_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

/**
 * 把一条消息正文清洗成"只该被念出来的内容"：
 * 去 HTML/CSS → 去旁白（方括号/括号里的动作、表演指令）→ 去英文 → 折叠空白。
 * options.keepSoundTags：保留 MiniMax 官方 Sound Tag（OpenAI 这类不支持标签的引擎传 false）。
 * options.dropLatin：剔除残留英文，只念中文台词。
 * 注意：正文完全不含中文时不删英文，否则纯英文角色会直接没声。
 */
export function sanitizeSpeechText(raw: string, options?: { keepSoundTags?: boolean; dropLatin?: boolean }): string {
    if (!raw) return "";
    const keepSoundTags = options?.keepSoundTags === true;
    const dropLatin = options?.dropLatin === true;

    let text = raw;

    // 1. HTML 实体还原成字符，避免 "&amp;" 被念成 "and"
    text = text
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");

    // 2. 先把"要保留的东西"摘成占位符，免得被后面的规则误伤。
    const kept: string[] = [];
    const stash = (value: string): string => `\u0000${kept.push(value) - 1}\u0000`;
    // 2a. MiniMax 停顿标记 <#0.3#> —— 长得像 HTML 标签，必须先摘出来
    text = text.replace(/<\s*#[0-9.]+\s*#\s*>/g, stash);
    // 2b. 官方 Sound Tag（世界书用英文半角括号写标签，如 (breath)）
    if (keepSoundTags) {
        // 非官方标签先按 §7.2 换成官方组合——否则它们会被模型当台词念出来。
        for (const [pattern, replacement] of MINIMAX_NONOFFICIAL_TAGS) {
            text = text.replace(pattern, replacement);
        }
        // 模型偶尔会写成全角括号（breath）——先归一成半角，否则第 4 步会把整段
        // 括号当旁白删掉，本该演出来的呼吸/笑意就没了。
        text = text.replace(
            new RegExp(`（\\s*(${MINIMAX_SOUND_TAGS.join("|")})\\s*）`, "gi"),
            (_, tag: string) => `(${tag.toLowerCase()})`,
        );
        text = text.replace(MINIMAX_SOUND_TAG_RE, m => stash(m.toLowerCase()));
    }

    // 3. 剥掉所有 HTML 标签 —— style 属性里的整串 CSS 英文随之消失（"大段英文"的根源）
    text = text.replace(/<[^>]*>/g, " ");

    // 4. 旁白/动作/表演指令都不是台词：方括号、中文括号、圆括号、花括号、书名号
    text = text
        .replace(/\[[^\]]*\]/g, " ")
        .replace(/【[^】]*】/g, " ")
        .replace(/（[^）]*）/g, " ")
        .replace(/\([^)]*\)/g, " ")
        .replace(/\{[^}]*\}/g, " ")
        .replace(/《[^》]*》/g, " ")
        .replace(/〈[^〉]*〉/g, " ")
        // markdown 强调记号本身不是台词，但括号里的文字要保留：
        // 把 **重点** 之类清成 重点，避免整段台词被误删。
        .replace(/[*~]+/g, " ");

    // 5. 清掉没能配对、残留的括号与尖括号
    text = text.replace(/[\[\]【】（）(){}《》〈〉<>]/g, " ");

    // 6. 只念中文台词：剔除残留英文（CSS 碎片、误留的非官方标签等）。
    //    正文完全没中文时保留英文，否则纯英文角色会失声。
    if (dropLatin && HAS_CHINESE_RE.test(text)) text = text.replace(/[A-Za-z]+/g, " ");

    // 7. 去掉 emoji / 图形符号（同样不是台词）
    text = text.replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/gu, " ");

    // 8. 折叠空白：保留段落换行，去掉多余空格
    text = text
        .replace(/[^\S\n]+/g, " ")
        .replace(/ ?\n ?/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    // 9. 还原第 2 步保留的标签
    text = text.replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)] ?? "");

    // 10. 收尾：去掉中文标点前的多余空格，让断句更自然
    text = text.replace(/[ \t]+([，。！？、；：…])/g, "$1").replace(/[ \t]{2,}/g, " ");
    return text.trim();
}

/**
 * 剥掉表演标记后还有可念的内容吗？
 * 只写 (breath)/(sighs) 或 <#0.3#> 的消息是纯表演指令，不是台词——不该被朗读。
 */
function hasSpeakableContent(speechText: string): boolean {
    const stripped = speechText
        .replace(/<\s*#[0-9.]+\s*#\s*>/g, "")
        .replace(MINIMAX_SOUND_TAG_RE, "");
    return /[A-Za-z0-9\u3400-\u9fff\uf900-\ufaff]/.test(stripped);
}

/**
 * 从台词里推断情绪，交给 MiniMax 的 voice_setting.emotion，让语气有起伏。
 * 优先看模型自己按世界书写下的 Sound Tag（强信号），再用几个几乎不会误伤的关键词兜底；
 * 都不命中就返回 null —— 不传 emotion，让模型按语义自行判断（传错情绪比不传更伤自然人声）。
 */
const MINIMAX_TAG_EMOTION: Array<[string, RegExp]> = [
    // 只取语义明确的标签。叹气/鼻息在不同情绪下都会出现，不在这里强行定情绪，
    // 免得把温柔的亲昵场景误判成"悲伤"；这类留给关键词或模型自行判断。
    ["happy", /\((laughs|chuckle)\)/i],
    ["sad", /\(sniffs\)/i],
    ["surprised", /\(gasp\)/i],
];

const MINIMAX_KEYWORD_EMOTION: Array<[string, RegExp]> = [
    // 世界书 §2.3.8：温柔/亲近 = happy + 更慢的语速、更低的音高（哄人时不能念得像播报）
    ["gentle", /(乖|别怕|不怕|没事|我在|慢慢来|不着急|听话|哄|摸头|抱住|抱紧|轻点|轻一些)/],
    ["happy", /(哈哈|嘿嘿|嘻嘻|开心|高兴|太好了|好耶|么么|抱抱|亲亲|喜欢|笑死)/],
    ["sad", /(呜呜|难过|伤心|悲伤|失落|沮丧|想哭|哭了|舍不得)/],
    ["angry", /(生气|愤怒|恼火|火大|混蛋|讨厌|烦死|凭什么|闭嘴)/],
    ["surprised", /(震惊|惊讶|居然|竟然|天哪|天呐|不是吧|真的假的|什么鬼)/],
    ["fearful", /(害怕|好怕|吓死|吓人|紧张|不敢)/],
];

function inferMinimaxEmotion(text: string): string | null {
    for (const [emotion, re] of MINIMAX_TAG_EMOTION) if (re.test(text)) return emotion;
    for (const [emotion, re] of MINIMAX_KEYWORD_EMOTION) if (re.test(text)) return emotion;
    return null;
}

// ── 呼吸/停顿补全（世界书 §2.1 呼吸栏）────────────────
// 角色没按世界书写呼吸标记时，MiniMax 会一字不差地匀速念完——这正是"AI 腔"最明显
// 的地方。这里在句末标点（语义边界，绝不会切进词里）之间补一次 (breath)：
// 真人说话本来就在这里换气，MiniMax 会把标签演绎成真的吸气声，顺带把语流切开。
const CJK_CHAR_RE = /[\u3400-\u9fff\uf900-\ufaff]/g;
// 文本里已经有任何一个呼吸/语气标记就不再补：角色自己演过了，再叠一次会显得喘。
const EXISTING_TAG_RE = /\((?:laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasp|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\)/i;

function countCjk(text: string): number {
    return (text.match(CJK_CHAR_RE) || []).length;
}

/** 单条长句（中间只有逗号）在靠近句中的那处逗号后换气——世界书 BRE-05。 */
function insertBreathAtMiddleComma(text: string): string {
    const clauses = text.split(/(?<=[，、；])/).map(s => s.trim()).filter(Boolean);
    if (clauses.length < 2) return text;
    const total = countCjk(text);
    let acc = 0;
    let insertAt = -1;
    let bestDiff = Infinity;
    for (let i = 0; i < clauses.length - 1; i += 1) {
        acc += countCjk(clauses[i]);
        const diff = Math.abs(acc - total / 2);
        if (diff < bestDiff) { bestDiff = diff; insertAt = i + 1; }
    }
    if (insertAt < 1) return text;
    return clauses.map((clause, i) => (i === insertAt ? `(breath) ${clause}` : clause)).join("");
}

export function addMinimaxBreathMarks(text: string): string {
    if (!text || EXISTING_TAG_RE.test(text)) return text;
    const cjkCount = countCjk(text);
    // 短句本来就是一口气说完的，硬加换气反而假（§2.1 注意：每 100 字 3-4 处为上限）。
    if (cjkCount < 16) return text;

    const sentences = text.split(/(?<=[。！？!?…])/).map(s => s.trim()).filter(Boolean);
    if (sentences.length < 2) {
        return cjkCount >= 30 ? insertBreathAtMiddleComma(text) : text;
    }

    let budget = Math.max(1, Math.min(4, Math.round(cjkCount / 100 * 3)));
    const out: string[] = [sentences[0]];
    for (let i = 1; i < sentences.length; i += 1) {
        const sentence = sentences[i];
        // 只在够长的句子前换气；短句连读才像人在说话。
        if (budget > 0 && countCjk(sentence) >= 10) {
            out.push(`(breath) ${sentence}`);
            budget -= 1;
        } else {
            out.push(sentence);
        }
    }
    return out.join("");
}

// 世界书 §2.3 / §三：不同情绪的音高、语速本来就不同——生气是前慢后快、难过是
// 拖腔下沉、惊讶是骤升。只给一个 emotion 参数，音色对了但语速节奏还是匀速念稿。
// 这里按情绪表带一点 speed/pitch 偏移，只在用户没手工调过时生效（用户调过的优先）。
const MINIMAX_EMOTION_TUNING: Record<string, { speed: number; pitch: number }> = {
    gentle: { speed: 0.9, pitch: -1 },
    happy: { speed: 1.05, pitch: 1 },
    sad: { speed: 0.9, pitch: -1 },
    angry: { speed: 0.95, pitch: -1 },
    surprised: { speed: 1.0, pitch: 2 },
    fearful: { speed: 1.05, pitch: 1 },
    disgusted: { speed: 0.92, pitch: -1 },
    calm: { speed: 0.95, pitch: 0 },
};

async function synthesizeMinimax(text: string, config: VoiceApiConfig, emotion?: string): Promise<Blob | null> {
    if (!config.apiKey) throw new Error("Minimax API Key 未配置");

    // 终极保险：送进 MiniMax 的 text 绝不允许含任何括号字符。
    // 任何绕过清洗链的新入口都会立刻在这里暴露并阻断。
    // 台词正文里的英文不拦——用户要求英文照常念出来，只有括号内不许念。
    if (/[（）()【】《》〈〉\[\]{}]/.test(text)) {
        console.error("[TTS 保险阻断] 送进 MiniMax 的文本含未清洗的括号，已拒绝发送：", text.slice(0, 200));
        return null;
    }

    const normalizedEmotion = emotion?.trim().toLowerCase();
    const tuning = normalizedEmotion ? MINIMAX_EMOTION_TUNING[normalizedEmotion] : undefined;
    // 世界书 §2.3.8 的"温柔"没有对应 emotion 取值：拿到 happy 的柔和基线，
    // 再用 tuning 把语速压慢、音高压低，避免把哄人的话念成播报腔。
    const sentEmotion = normalizedEmotion === "gentle" ? "happy" : normalizedEmotion;
    const useEmotion = !!sentEmotion && MINIMAX_EMOTIONS.has(sentEmotion);

    const baseUrl = (config.baseUrl || "https://api.minimaxi.com/v1").replace(/\/$/, "");
    const voiceSetting: Record<string, unknown> = {
        voice_id: config.defaultVoice || "male-qn-qingse",
        speed: normalizeMinimaxSpeed(
            typeof config.speechSpeed === "number" ? config.speechSpeed : tuning?.speed,
        ),
        vol: 1.0,
        pitch: normalizeMinimaxPitch(
            typeof config.speechPitch === "number" ? config.speechPitch : tuning?.pitch,
        ),
    };

    const request = (withEmotion: boolean) => fetchWithTimeout(`${baseUrl}/t2a_v2`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: config.model || "speech-01-turbo",
            text,
            stream: false,
            ...(config.languageBoost ? { language_boost: config.languageBoost } : {}),
            voice_setting: withEmotion && useEmotion ? { ...voiceSetting, emotion: sentEmotion } : voiceSetting,
            // 44100/256k 是 Minimax 支持的最高档;之前 32000/128k 会把 hd 模型
            // 的输出压闷(用户反馈"声音糊"),各模型均支持该档位。
            audio_setting: {
                sample_rate: 44100,
                bitrate: 256000,
                format: "mp3",
                channel: 1,
            },
        }),
    });

    let response = await request(true);
    // 情绪参数在个别模型/账号上不被接受。语音是刚需，不能因为一个可选的
    // 情绪参数被拒就整条失声——退一步用原声再发一次。
    if (!response.ok && useEmotion) response = await request(false);

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.base_resp?.status_msg || `Minimax API 请求失败 (${response.status})`);
    }

    const data = await response.json();
    if (data.data?.audio) {
        const hexString: string = data.data.audio;
        const bytes = new Uint8Array(hexString.length / 2);
        for (let i = 0; i < hexString.length; i += 2) {
            bytes[i / 2] = parseInt(hexString.substring(i, i + 2), 16);
        }
        return new Blob([bytes], { type: "audio/mpeg" });
    }

    throw new Error(data.base_resp?.status_msg || "Minimax 未返回音频数据");
}

// ── OpenAI TTS ──────────────────────────────────────

async function synthesizeOpenAI(text: string, config: VoiceApiConfig): Promise<Blob | null> {
    if (!config.apiKey) throw new Error("OpenAI API Key 未配置");

    const baseUrl = config.baseUrl || "https://api.openai.com/v1";
    const response = await fetchWithTimeout(`${baseUrl.replace(/\/$/, "")}/audio/speech`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: config.model || "tts-1",
            input: text,
            voice: config.defaultVoice || "alloy",
            response_format: "mp3",
            ...(typeof config.speechSpeed === "number" && Number.isFinite(config.speechSpeed)
                ? { speed: Math.min(2, Math.max(0.5, config.speechSpeed)) }
                : {}),
        }),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`OpenAI TTS 请求失败 (${response.status}): ${errText}`);
    }

    const blob = await response.blob();
    return new Blob([await blob.arrayBuffer()], { type: "audio/mpeg" });
}

// ── Fish Audio TTS ──────────────────────────────────

async function synthesizeFishAudio(text: string, config: VoiceApiConfig): Promise<Blob | null> {
    if (!config.apiKey) throw new Error("Fish Audio API Key 未配置");

    // Fish Audio 没开 CORS，浏览器直连会被预检拦掉，统一走同源的服务端中转。
    const response = await fetchWithTimeout("/api/voice/fish-tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            apiKey: config.apiKey,
            baseUrl: config.baseUrl,
            model: config.model,
            voiceId: config.defaultVoice,
            text,
            format: "mp3",
            speed: config.speechSpeed,
        }),
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.message || `Fish Audio TTS 请求失败 (${response.status})`);
    }

    const blob = await response.blob();
    if (!blob.size) throw new Error("Fish Audio 未返回音频数据");
    return new Blob([await blob.arrayBuffer()], { type: "audio/mpeg" });
}

// ── iOS audio playback that coexists with speech recognition ──────────
// On iOS Safari, playing TTS through an <audio> element keeps the system audio
// session in "playback" mode, which steals the mic from webkitSpeechRecognition
// and stops it from restarting on the next turn (calls go silent after one
// round). To keep hands-free multi-turn working we play through a Web Audio
// AudioContext and explicitly suspend() it after each clip so iOS hands the
// audio session back to the microphone. A shared <audio> element is kept as a
// fallback for browsers without AudioContext.

let _audioCtx: AudioContext | null = null;
let _sharedAudio: HTMLAudioElement | null = null;
let _audioUnlocked = false;
let _unlockListenerInstalled = false;

// ── In-app TTS volume (0..1) ──
// iOS plays Web Audio on the ringer/voice stream, so the hardware volume keys
// don't control character speech. This in-app gain does. Synced to localStorage.
const TTS_VOLUME_KEY = "ai_phone_tts_volume_v1";
let _ttsVolume = ((): number => {
    if (typeof window === "undefined") return 1;
    try {
        const raw = window.localStorage.getItem(TTS_VOLUME_KEY);
        const v = raw == null ? 1 : Number(raw);
        return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
    } catch { return 1; }
})();
// Live gain node of the currently-playing AudioContext clip, so the slider can
// adjust volume mid-sentence.
let _activeGain: GainNode | null = null;

export function getTtsVolume(): number {
    return _ttsVolume;
}

export function setTtsVolume(volume: number): void {
    _ttsVolume = Math.min(1, Math.max(0, volume));
    try { window.localStorage.setItem(TTS_VOLUME_KEY, String(_ttsVolume)); } catch { /* ignore */ }
    if (_activeGain) { try { _activeGain.gain.value = _ttsVolume; } catch { /* ignore */ } }
    if (_sharedAudio) { try { _sharedAudio.volume = _ttsVolume; } catch { /* ignore */ } }
}

// ── 通话音频会话开关 ──
// 只有通话界面在场时才让 Web Audio 上下文保持 running。此前全局点击解锁会把
// 上下文永久 resume，页面从第一次点击起就一直持有系统音频会话；叠加通话退出
// 后识别泄漏，整页音频会被钉在"通话模式"（语音条/试听音量巨大且音量键失灵）。
let _callAudioSessionActive = false;

/** 通话界面挂载时置 true、卸载/挂断时置 false（false 时立即挂起空闲的上下文）。 */
export function setCallAudioSessionActive(active: boolean): void {
    _callAudioSessionActive = active;
    if (!active && _audioCtx && !_activeGain) {
        try { void _audioCtx.suspend(); } catch { /* ignore */ }
    }
}

function getAudioContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    if (!_audioCtx) {
        // 不要钉 sampleRate:部分 iOS 版本上非硬件采样率的 ctx 会"时钟照走、
        // 输出全静音"(比闷更糟)。防发闷靠 TTS 请求参数(44100/256k)兜底。
        try { _audioCtx = new Ctor(); } catch { return null; }
    }
    return _audioCtx;
}

function getSharedAudio(): HTMLAudioElement {
    if (!_sharedAudio) {
        _sharedAudio = new Audio();
        _sharedAudio.setAttribute("playsinline", "");
    }
    return _sharedAudio;
}

function silentWavUrl(): string {
    // A few ms of 16-bit mono PCM silence — a valid source so play() actually
    // starts (and thus unlocks the element) on iOS.
    // 采样率用 48kHz 而不是 8kHz：iOS 的系统音频会话采样率会跟着刚播放的媒体走，
    // 解锁音若是 8kHz，紧接着播的 TTS 会被压到 4kHz 以下而发闷（与保活音同理）。
    const sampleRate = 48000;
    const numSamples = 96; // 2ms
    const dataSize = numSamples * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); writeStr(8, "WAVE");
    writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    writeStr(36, "data"); view.setUint32(40, dataSize, true);
    // 16-bit PCM 静音为 0，ArrayBuffer 默认全 0，无需再写
    return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

/**
 * Unlock audio playback. Must run inside (or synchronously from) a user gesture.
 * Resumes the AudioContext (primary path) and unlocks the <audio> fallback.
 * Safe to call repeatedly.
 */
export function unlockAudioPlayback(): void {
    if (typeof window === "undefined") return;

    // Primary path: resume the Web Audio context within the gesture. Once
    // resumed under a gesture, subsequent programmatic resume()s are allowed.
    // 非通话期只借这次手势拿"授权"，随即挂起——不让页面平时一直持有音频会话。
    const ctx = getAudioContext();
    if (ctx && ctx.state === "suspended") {
        const keepRunning = _callAudioSessionActive;
        ctx.resume().then(() => {
            if (!keepRunning && !_activeGain && !_callAudioSessionActive) {
                try { void ctx.suspend(); } catch { /* ignore */ }
            }
        }).catch(() => {});
    }

    // Fallback path: unlock the shared <audio> element once.
    if (_audioUnlocked) return;
    const audio = getSharedAudio();
    const url = silentWavUrl();
    audio.muted = true;
    audio.src = url;
    const finish = () => {
        try { audio.pause(); audio.currentTime = 0; } catch {}
        audio.muted = false;
        URL.revokeObjectURL(url);
        _audioUnlocked = true;
    };
    try {
        const p = audio.play();
        if (p && typeof p.then === "function") {
            p.then(finish).catch(() => { audio.muted = false; URL.revokeObjectURL(url); });
        } else {
            finish();
        }
    } catch {
        audio.muted = false;
        URL.revokeObjectURL(url);
    }
}

function installUnlockListener(): void {
    if (_unlockListenerInstalled || typeof window === "undefined") return;
    _unlockListenerInstalled = true;
    const handler = () => { unlockAudioPlayback(); };
    window.addEventListener("touchend", handler, { passive: true });
    window.addEventListener("pointerdown", handler, { passive: true });
    window.addEventListener("mousedown", handler, { passive: true });
}

// Install the first-gesture unlock as soon as this module loads on the client.
// The call screens import this module statically (via chat-room), so the
// listener is in place well before the user taps the call button.
if (typeof window !== "undefined") installUnlockListener();

function decodeAudio(ctx: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
    // Support both the promise and legacy callback forms (older webkitAudioContext).
    return new Promise((resolve, reject) => {
        const ret = ctx.decodeAudioData(data, resolve, reject);
        if (ret && typeof (ret as Promise<AudioBuffer>).then === "function") {
            (ret as Promise<AudioBuffer>).then(resolve, reject);
        }
    });
}

/**
 * Playback via a shared <audio> element. Used as the fallback when AudioContext
 * is unavailable, and as the PRIMARY path for gesture-less auto-play scenarios
 * (e.g. VN/漫卷 auto voice): a media element that was unlocked once keeps playing
 * programmatically, whereas resuming a suspended AudioContext far from any user
 * gesture is often rejected on Android Chrome/Edge (the "only plays with WeChat
 * keep-alive on" bug — the keep-alive's looping silent <audio> was what kept the
 * context alive). Bonus: media-element playback also obeys hardware volume keys.
 */
export function playAudioBlobViaMediaElement(blob: Blob): { promise: Promise<void>; abort: () => void } {
    return playAudioBlobElement(blob);
}

function playAudioBlobElement(blob: Blob): { promise: Promise<void>; abort: () => void } {
    const url = URL.createObjectURL(blob);
    const audio = getSharedAudio();
    audio.muted = false;
    audio.volume = _ttsVolume;
    audio.src = url;

    let settled = false;
    let resolveFn: () => void = () => {};
    let guardTimer: ReturnType<typeof setTimeout> | null = null;
    const clearGuard = () => {
        if (guardTimer !== null) { clearTimeout(guardTimer); guardTimer = null; }
    };
    const finalize = () => {
        if (settled) return;
        settled = true;
        clearGuard();
        audio.onended = null;
        audio.onerror = null;
        audio.onpause = null;
        audio.onloadedmetadata = null;
        URL.revokeObjectURL(url);
        try { audio.pause(); audio.removeAttribute("src"); audio.load(); } catch {}
        resolveFn();
    };
    // 播放被别的 App（如后台刷视频）抢走音频焦点时，浏览器只会发一个 pause，
    // ended 永远不会来——await promise 就此挂死，调用方状态机卡在「对方正在说话」，
    // 排队的消息再也等不到 IDLE。把这种「非我们主动的暂停」当作播放结束。
    const onPause = () => { if (!settled) finalize(); };
    // 兜底闸门：万一连 pause 都不发（play() 悬着、缓冲卡死），也要让 promise 落定。
    // 音频时长已知就按它放宽，未知给一个固定上限。
    const armGuard = () => {
        clearGuard();
        const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
        const capMs = duration > 0 ? (duration * 2 + 15) * 1000 : 180_000;
        guardTimer = setTimeout(() => { if (!settled) finalize(); }, capMs);
    };
    const promise = new Promise<void>((resolve) => {
        resolveFn = resolve;
        audio.onended = finalize;
        audio.onerror = finalize;
        audio.onpause = onPause;
        audio.onloadedmetadata = armGuard;
        armGuard();
        audio.play().catch(() => {
            finalize();
        });
    });
    return { promise, abort: finalize };
}

/**
 * Play an audio blob through the Web Audio context and resolve when playback
 * ends. After playback the context is suspended so iOS releases the audio
 * session back to the microphone (lets SpeechRecognition restart next turn).
 * Returns an abort function to stop playback early. Playback is sequential.
 */
export function playAudioBlob(blob: Blob): { promise: Promise<void>; abort: () => void } {
    const ctx = getAudioContext();
    if (!ctx) return playAudioBlobElement(blob);

    let settled = false;
    let resolveFn: () => void = () => {};
    let source: AudioBufferSourceNode | null = null;

    let gain: GainNode | null = null;
    let fallbackAbort: (() => void) | null = null;

    const cleanupWebAudio = () => {
        if (source) {
            source.onended = null;
            try { source.stop(); } catch {}
            try { source.disconnect(); } catch {}
            source = null;
        }
        if (gain) { try { gain.disconnect(); } catch {} }
        if (_activeGain === gain) _activeGain = null;
        gain = null;
        // Suspend so iOS hands the audio session back to the microphone.
        try { ctx.suspend(); } catch {}
    };

    const finalize = () => {
        if (settled) return;
        settled = true;
        cleanupWebAudio();
        if (fallbackAbort) { fallbackAbort(); fallbackAbort = null; }
        resolveFn();
    };

    const promise = new Promise<void>((resolve) => {
        resolveFn = resolve;
        (async () => {
            try {
                if (ctx.state === "suspended") {
                    // 程序化 resume 在部分安卓浏览器上会被拒绝，甚至让 promise 永远
                    // 悬着（要等下一次用户手势）。限时等待后检查状态，走不通就回落。
                    await Promise.race([
                        ctx.resume().catch(() => {}),
                        new Promise(r => setTimeout(r, 800)),
                    ]);
                }
                if (ctx.state !== "running") throw new Error("audio_context_not_running");
                const audioBuffer = await decodeAudio(ctx, await blob.arrayBuffer());
                if (settled) return;
                source = ctx.createBufferSource();
                source.buffer = audioBuffer;
                // Route through a gain node so the in-app volume slider applies.
                gain = ctx.createGain();
                gain.gain.value = _ttsVolume;
                source.connect(gain);
                gain.connect(ctx.destination);
                _activeGain = gain;
                source.onended = finalize;
                source.start();
            } catch {
                // Web Audio 走不通（resume 被拒/解码失败等）时回落媒体元素播放：
                // 宁可这一段绕过「iOS 归还麦克风」的优化，也不要静默无声——
                // 此前这里直接 finalize，正是「语音条有声、通话没声」的来源之一。
                if (settled) return;
                cleanupWebAudio();
                const fallback = playAudioBlobElement(blob);
                fallbackAbort = fallback.abort;
                void fallback.promise.then(() => {
                    if (settled) return;
                    settled = true;
                    fallbackAbort = null;
                    resolveFn();
                });
            }
        })();
    });

    return { promise, abort: finalize };
}
