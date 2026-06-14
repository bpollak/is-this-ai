import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

type Verdict =
  | "Verified AI"
  | "Likely AI"
  | "Possibly AI"
  | "Inconclusive"
  | "Likely human-made";

type Signal = {
  label: string;
  value: string;
  impact: "raises" | "lowers" | "neutral";
  detail: string;
};

type AnalysisResult = {
  score: number;
  verdict: Verdict;
  confidence: "High" | "Medium" | "Low";
  watermarkStatus: "Detected" | "Not detected" | "Not checked";
  provenanceStatus: "Verified" | "Missing" | "Not checked";
  inspectionStatus:
    | "Uploaded file"
    | "Resolved media"
    | "Representative frame"
    | "Metadata only"
    | "URL only";
  summary: string;
  signals: Signal[];
};

type SocialPlatform =
  | "Instagram"
  | "TikTok"
  | "YouTube"
  | "Vimeo"
  | "X/Twitter"
  | "Facebook"
  | "Threads";

type PixelStats = {
  colorEntropy: number;
  edgeDensity: number;
  smoothness: number;
  saturation: number;
  compressionProxy: number;
};

type MediaCandidate = {
  url: string;
  type: "image" | "video" | "unknown";
  source: "direct-url" | "resolver" | "oembed";
  sourceLabel: string;
};

type ApiRequest = IncomingMessage & {
  body: unknown;
};

type ApiResponse = ServerResponse & {
  status: (statusCode: number) => ApiResponse;
  json: (body: unknown) => void;
};

type UrlCandidate = {
  key: string;
  url: string;
};

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static") as string | null;
const maxImageBytes = 12 * 1024 * 1024;
const maxVideoBytes = 64 * 1024 * 1024;
const fetchTimeoutMs = 15000;

const socialHosts = [
  "instagram.com",
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "vimeo.com",
  "x.com",
  "twitter.com",
  "facebook.com",
  "fb.watch",
  "threads.net",
];

const aiTerms = [
  "ai-generated",
  "aigenerated",
  "text-to-video",
  "txt2vid",
  "text-to-image",
  "txt2img",
  "generated-by-ai",
  "synthid",
  "midjourney",
  "runway",
  "pika",
  "sora",
  "kling",
  "veo",
  "stable-diffusion",
  "dall-e",
  "dalle",
  "flux",
];

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (request.method !== "POST") {
    response.status(405).json({ message: "Use POST with a JSON body containing url." });
    return;
  }

  try {
    const rawUrl = getRequestUrl(request.body);
    const parsedUrl = parsePublicUrl(rawUrl);
    const platform = detectSocialPlatform(parsedUrl.href);
    const directCandidate = directMediaCandidate(parsedUrl);
    const candidate =
      directCandidate ??
      await resolveSocialCandidate(parsedUrl, platform);

    if (!candidate) {
      response.status(200).json({
        result: metadataOnlyResult(parsedUrl.href, platform, "No resolver returned downloadable media."),
      });
      return;
    }

    const result = await analyzeCandidate(candidate, parsedUrl.href, platform);
    response.status(200).json({ result });
  } catch (error) {
    response.status(400).json({
      message:
        error instanceof Error
          ? error.message
          : "The link could not be analyzed.",
    });
  }
}

function getRequestUrl(body: unknown) {
  if (!body || typeof body !== "object" || !("url" in body)) {
    throw new Error("Paste a media or social post URL first.");
  }

  const value = (body as { url?: unknown }).url;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Paste a media or social post URL first.");
  }

  return value.trim();
}

function parsePublicUrl(rawUrl: string) {
  const normalized = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  const parsedUrl = new URL(normalized);

  if (!["https:", "http:"].includes(parsedUrl.protocol)) {
    throw new Error("Only HTTP and HTTPS links can be analyzed.");
  }

  if (parsedUrl.protocol === "http:" && process.env.ALLOW_HTTP_MEDIA_URLS !== "true") {
    throw new Error("Use an HTTPS media link.");
  }

  if (isBlockedHostname(parsedUrl.hostname)) {
    throw new Error("Private or local network links are not accepted.");
  }

  return parsedUrl;
}

function isBlockedHostname(hostname: string) {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".local") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  );
}

async function resolveSocialCandidate(
  parsedUrl: URL,
  platform: SocialPlatform | null,
): Promise<MediaCandidate | null> {
  if (!platform && !socialHosts.some((host) => parsedUrl.hostname.includes(host))) {
    return null;
  }

  const providerCandidate = await resolveWithProvider(parsedUrl.href);
  if (providerCandidate) return providerCandidate;

  return resolveWithOembed(parsedUrl.href, platform);
}

async function resolveWithProvider(url: string): Promise<MediaCandidate | null> {
  const endpoint = process.env.SOCIAL_RESOLVER_ENDPOINT;
  if (!endpoint) return null;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (process.env.SOCIAL_RESOLVER_API_KEY) {
    headers.Authorization = `Bearer ${process.env.SOCIAL_RESOLVER_API_KEY}`;
  }

  const providerResponse = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ url }),
  });

  if (!providerResponse.ok) {
    return null;
  }

  const payload = await providerResponse.json() as unknown;
  const candidates = collectUrlCandidates(payload);
  const preferred = pickBestCandidate(candidates);
  if (!preferred) return null;

  const parsedUrl = parsePublicUrl(preferred.url);
  return {
    url: parsedUrl.href,
    type: mediaTypeFromUrl(preferred.url, preferred.key),
    source: "resolver",
    sourceLabel: "Social media resolver",
  };
}

async function resolveWithOembed(
  url: string,
  platform: SocialPlatform | null,
): Promise<MediaCandidate | null> {
  const endpoint = oembedEndpoint(url, platform);
  if (!endpoint) return null;

  const oembedResponse = await fetchWithTimeout(endpoint);
  if (!oembedResponse.ok) return null;

  const payload = await oembedResponse.json() as unknown;
  const thumbnailUrl = findStringField(payload, "thumbnail_url");
  if (!thumbnailUrl) return null;

  const parsedUrl = parsePublicUrl(thumbnailUrl);
  return {
    url: parsedUrl.href,
    type: "image",
    source: "oembed",
    sourceLabel: `${platform ?? "Social"} oEmbed thumbnail`,
  };
}

function oembedEndpoint(url: string, platform: SocialPlatform | null) {
  const encodedUrl = encodeURIComponent(url);

  if (platform === "YouTube") {
    return `https://www.youtube.com/oembed?format=json&url=${encodedUrl}`;
  }

  if (platform === "TikTok") {
    return `https://www.tiktok.com/oembed?url=${encodedUrl}`;
  }

  if (platform === "Vimeo") {
    return `https://vimeo.com/api/oembed.json?url=${encodedUrl}`;
  }

  if (platform === "Instagram" && process.env.META_APP_ID && process.env.META_APP_SECRET) {
    const token = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;
    return `https://graph.facebook.com/instagram_oembed?url=${encodedUrl}&access_token=${encodeURIComponent(token)}`;
  }

  return "";
}

async function analyzeCandidate(
  candidate: MediaCandidate,
  originalUrl: string,
  platform: SocialPlatform | null,
): Promise<AnalysisResult> {
  if (candidate.type === "video") {
    const frame = await extractVideoFrame(candidate.url);
    return resultFromStats({
      stats: await statsFromImage(frame),
      originalUrl,
      platform,
      sourceLabel: candidate.sourceLabel,
      inspectionStatus: candidate.source === "oembed" ? "Representative frame" : "Resolved media",
      sampledMedia: "video frame",
    });
  }

  const downloaded = await downloadUrl(candidate.url, maxImageBytes);
  return resultFromStats({
    stats: await statsFromImage(downloaded.buffer),
    originalUrl,
    platform,
    sourceLabel: candidate.sourceLabel,
    inspectionStatus: candidate.source === "oembed" ? "Representative frame" : "Resolved media",
    sampledMedia: candidate.source === "oembed" ? "social thumbnail" : "resolved image",
  });
}

async function extractVideoFrame(mediaUrl: string) {
  if (!ffmpegPath) {
    throw new Error("Video frame extraction is not available in this runtime.");
  }

  const downloaded = await downloadUrl(mediaUrl, maxVideoBytes);
  const id = randomUUID();
  const inputPath = path.join(tmpdir(), `${id}-input`);
  const outputPath = path.join(tmpdir(), `${id}-frame.jpg`);

  try {
    await writeFile(inputPath, downloaded.buffer);
    await run(ffmpegPath, [
      "-y",
      "-ss",
      "00:00:01",
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=160:-1",
      "-f",
      "image2",
      outputPath,
    ], { timeout: 20000 });
    return await readFile(outputPath);
  } finally {
    await Promise.allSettled([unlink(inputPath), unlink(outputPath)]);
  }
}

async function downloadUrl(url: string, maxBytes: number) {
  const response = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "is-this-ai-media-triage/0.1",
    },
  });

  if (!response.ok) {
    throw new Error(`Media download failed with HTTP ${response.status}.`);
  }

  if (!response.body) {
    throw new Error("The media response did not include a body.");
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      throw new Error("The resolved media is too large for this serverless analyzer.");
    }
    chunks.push(value);
  }

  return {
    buffer: Buffer.concat(chunks),
    contentType: response.headers.get("content-type") ?? "",
  };
}

async function fetchWithTimeout(input: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function statsFromImage(imageBuffer: Buffer): Promise<PixelStats> {
  const { data, info } = await sharp(imageBuffer)
    .rotate()
    .resize({
      width: 96,
      height: 96,
      fit: "inside",
      withoutEnlargement: true,
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const count = info.width * info.height;
  const bins = new Array<number>(32).fill(0);
  const luminance = new Float32Array(count);
  let saturationSum = 0;

  for (let offset = 0, pixel = 0; offset < data.length; offset += info.channels, pixel += 1) {
    const r = data[offset] / 255;
    const g = data[offset + 1] / 255;
    const b = data[offset + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    luminance[pixel] = luma;
    saturationSum += max === 0 ? 0 : (max - min) / max;
    bins[Math.min(31, Math.floor(luma * 32))] += 1;
  }

  let entropy = 0;
  for (const bin of bins) {
    if (bin === 0) continue;
    const probability = bin / count;
    entropy -= probability * Math.log2(probability);
  }

  let edgeHits = 0;
  let edgeSum = 0;
  let comparisons = 0;

  for (let y = 1; y < info.height; y += 1) {
    for (let x = 1; x < info.width; x += 1) {
      const index = y * info.width + x;
      const dx = Math.abs(luminance[index] - luminance[index - 1]);
      const dy = Math.abs(luminance[index] - luminance[index - info.width]);
      const delta = dx + dy;
      edgeSum += delta;
      comparisons += 1;
      if (delta > 0.18) edgeHits += 1;
    }
  }

  const compressionProxy = comparisons === 0 ? 0 : edgeSum / comparisons;

  return {
    colorEntropy: entropy,
    edgeDensity: comparisons === 0 ? 0 : edgeHits / comparisons,
    smoothness: 1 - Math.min(1, compressionProxy * 3.6),
    saturation: saturationSum / count,
    compressionProxy,
  };
}

function resultFromStats({
  stats,
  originalUrl,
  platform,
  sourceLabel,
  inspectionStatus,
  sampledMedia,
}: {
  stats: PixelStats;
  originalUrl: string;
  platform: SocialPlatform | null;
  sourceLabel: string;
  inspectionStatus: "Resolved media" | "Representative frame";
  sampledMedia: string;
}): AnalysisResult {
  const signals: Signal[] = [];
  let score = 50;
  const loweredUrl = originalUrl.toLowerCase();
  const matchedTerms = aiTerms.filter((term) => loweredUrl.includes(term));

  signals.push({
    label: "Media access",
    value: sourceLabel,
    impact: "neutral",
    detail:
      inspectionStatus === "Resolved media"
        ? `The backend resolved and sampled a ${sampledMedia} from the submitted link.`
        : `The backend sampled a representative ${sampledMedia}; it did not inspect the full video stream.`,
  });

  if (matchedTerms.length > 0) {
    score += Math.min(18, matchedTerms.length * 7);
    signals.push({
      label: "URL language",
      value: matchedTerms.slice(0, 3).join(", "),
      impact: "raises",
      detail: "The URL contains terms commonly attached to generated media.",
    });
  } else {
    signals.push({
      label: "URL language",
      value: "No AI terms found",
      impact: "neutral",
      detail: "A clean social URL is not evidence of authenticity by itself.",
    });
  }

  if (stats.smoothness > 0.73 && stats.edgeDensity < 0.12) {
    score += 15;
    signals.push({
      label: "Texture",
      value: "Very smooth",
      impact: "raises",
      detail: "Generated media can contain broad smooth regions with fewer hard sensor edges.",
    });
  } else if (stats.edgeDensity > 0.24 && stats.compressionProxy > 0.16) {
    score -= 11;
    signals.push({
      label: "Texture",
      value: "Natural high-frequency detail",
      impact: "lowers",
      detail: "Dense small variation is more typical of captured camera media.",
    });
  } else {
    signals.push({
      label: "Texture",
      value: "Mixed",
      impact: "neutral",
      detail: "Pixel texture does not strongly favor either origin.",
    });
  }

  if (stats.colorEntropy > 4.9 && stats.saturation > 0.18) {
    score += 10;
    signals.push({
      label: "Color distribution",
      value: "Stylized",
      impact: "raises",
      detail: "Broad color variety and elevated saturation can appear in synthetic renders.",
    });
  } else if (stats.colorEntropy < 3.15 && stats.saturation < 0.1) {
    score -= 7;
    signals.push({
      label: "Color distribution",
      value: "Camera-like constrained palette",
      impact: "lowers",
      detail: "Lower saturation and modest color variety are common in ordinary captured footage.",
    });
  } else {
    signals.push({
      label: "Color distribution",
      value: "Ordinary range",
      impact: "neutral",
      detail: "Color statistics are not distinctive enough for a strong call.",
    });
  }

  const clampedScore = clampScore(score);

  return {
    score: clampedScore,
    verdict: verdictForScore(clampedScore),
    confidence: inspectionStatus === "Resolved media" ? "Medium" : "Low",
    watermarkStatus: "Not checked",
    provenanceStatus: "Not checked",
    inspectionStatus,
    summary:
      inspectionStatus === "Resolved media"
        ? `The backend resolved ${platform ? `the ${platform} link` : "the link"} and sampled media from it. This is still a heuristic score unless C2PA, SynthID, or another supported watermark verifies origin.`
        : `The backend could not access the full ${platform ? `${platform} ` : ""}video, so it sampled an available representative image only. This is weaker than frame-level video analysis.`,
    signals,
  };
}

function metadataOnlyResult(
  url: string,
  platform: SocialPlatform | null,
  reason: string,
): AnalysisResult {
  const lowered = url.toLowerCase();
  const matchedTerms = aiTerms.filter((term) => lowered.includes(term));
  const score = clampScore(50 + Math.min(22, matchedTerms.length * 8));

  const signals: Signal[] = [
    {
      label: "Media access",
      value: "Backend resolver needed",
      impact: "neutral",
      detail: reason,
    },
  ];

  if (platform) {
    signals.push({
      label: "Distribution",
      value: platform,
      impact: "neutral",
      detail: "The platform link was recognized, but downloadable media was not returned to the analyzer.",
    });
  }

  signals.push({
    label: "URL language",
    value: matchedTerms.length > 0 ? matchedTerms.slice(0, 3).join(", ") : "No AI terms found",
    impact: matchedTerms.length > 0 ? "raises" : "neutral",
    detail:
      matchedTerms.length > 0
        ? "The URL contains terms commonly attached to generated media."
        : "The URL alone is not enough to establish whether the media is AI-generated.",
  });

  return {
    score,
    verdict: verdictForScore(score),
    confidence: "Low",
    watermarkStatus: "Not checked",
    provenanceStatus: "Not checked",
    inspectionStatus: "Metadata only",
    summary:
      platform === "Instagram"
        ? "The backend recognized this as an Instagram link but did not receive downloadable Reel media. Configure a social media resolver on Vercel, or upload the saved Reel video for frame analysis."
        : `The backend recognized this ${platform ? `${platform} ` : ""}link but did not receive downloadable media. Configure a social media resolver on Vercel, or upload the saved video file.`,
    signals,
  };
}

function directMediaCandidate(parsedUrl: URL): MediaCandidate | null {
  const type = mediaTypeFromUrl(parsedUrl.href, parsedUrl.pathname);
  if (type === "unknown") return null;

  return {
    url: parsedUrl.href,
    type,
    source: "direct-url",
    sourceLabel: "Direct media URL",
  };
}

function collectUrlCandidates(input: unknown, parentKey = ""): UrlCandidate[] {
  if (!input) return [];

  if (typeof input === "string") {
    if (/^https?:\/\//i.test(input)) return [{ key: parentKey, url: input }];
    return [];
  }

  if (Array.isArray(input)) {
    return input.flatMap((item, index) => collectUrlCandidates(item, `${parentKey}[${index}]`));
  }

  if (typeof input === "object") {
    return Object.entries(input).flatMap(([key, value]) =>
      collectUrlCandidates(value, parentKey ? `${parentKey}.${key}` : key),
    );
  }

  return [];
}

function pickBestCandidate(candidates: UrlCandidate[]) {
  const mediaCandidates = candidates
    .map((candidate) => ({
      ...candidate,
      type: mediaTypeFromUrl(candidate.url, candidate.key),
      rank: rankCandidate(candidate),
    }))
    .filter((candidate) => candidate.type !== "unknown")
    .sort((a, b) => b.rank - a.rank);

  return mediaCandidates[0] ?? null;
}

function rankCandidate(candidate: UrlCandidate) {
  const key = candidate.key.toLowerCase();
  const url = candidate.url.toLowerCase();
  let rank = 0;

  if (/\.(mp4|m4v|mov|webm)(\?|$)/i.test(url)) rank += 50;
  if (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(url)) rank += 20;
  if (/(video|media|download|play|url|src)/i.test(key)) rank += 20;
  if (/(thumbnail|thumb|poster|cover|image)/i.test(key)) rank += 5;
  return rank;
}

function mediaTypeFromUrl(url: string, key = ""): "image" | "video" | "unknown" {
  const lowered = `${url} ${key}`.toLowerCase();
  if (/\.(mp4|m4v|mov|webm)(\?|$|\s)/i.test(lowered) || /(video_url|video|download_url)/i.test(key)) {
    return "video";
  }

  if (/\.(jpe?g|png|webp|gif)(\?|$|\s)/i.test(lowered) || /(thumbnail|thumb|poster|cover|image)/i.test(key)) {
    return "image";
  }

  return "unknown";
}

function findStringField(input: unknown, field: string): string {
  if (!input || typeof input !== "object") return "";
  const value = (input as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
}

function detectSocialPlatform(url: string): SocialPlatform | null {
  const lowered = url.toLowerCase();
  if (lowered.includes("instagram.com")) return "Instagram";
  if (lowered.includes("tiktok.com")) return "TikTok";
  if (lowered.includes("youtube.com") || lowered.includes("youtu.be")) return "YouTube";
  if (lowered.includes("vimeo.com")) return "Vimeo";
  if (lowered.includes("x.com") || lowered.includes("twitter.com")) return "X/Twitter";
  if (lowered.includes("facebook.com") || lowered.includes("fb.watch")) return "Facebook";
  if (lowered.includes("threads.net")) return "Threads";
  return null;
}

function verdictForScore(score: number): Verdict {
  if (score >= 95) return "Verified AI";
  if (score >= 76) return "Likely AI";
  if (score >= 58) return "Possibly AI";
  if (score <= 30) return "Likely human-made";
  return "Inconclusive";
}

function clampScore(score: number) {
  return Math.max(2, Math.min(98, Math.round(score)));
}
