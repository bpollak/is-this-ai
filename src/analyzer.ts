export type MediaKind = "image" | "video" | "link";
export type Verdict =
  | "Verified AI"
  | "Likely AI"
  | "Possibly AI"
  | "Inconclusive"
  | "Likely human-made";

export type Signal = {
  label: string;
  value: string;
  impact: "raises" | "lowers" | "neutral";
  detail: string;
};

export type AnalysisResult = {
  score: number;
  verdict: Verdict;
  confidence: "High" | "Medium" | "Low";
  watermarkStatus: "Detected" | "Not detected" | "Not checked";
  provenanceStatus: "Verified" | "Missing" | "Not checked";
  summary: string;
  signals: Signal[];
};

type PixelStats = {
  colorEntropy: number;
  edgeDensity: number;
  smoothness: number;
  saturation: number;
  compressionProxy: number;
};

const aiDomains = [
  "runwayml.com",
  "runway.com",
  "pika.art",
  "luma.ai",
  "klingai.com",
  "hailuoai.video",
  "midjourney.com",
  "sora.com",
  "openai.com/sora",
  "ideogram.ai",
  "leonardo.ai",
  "stability.ai",
  "firefly.adobe.com",
  "kaiber.ai",
  "synthesia.io",
  "heygen.com",
  "invideo.io",
  "veo",
  "genmo.ai",
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

export async function analyzeFile(file: File): Promise<AnalysisResult> {
  const kind = file.type.startsWith("video") ? "video" : "image";
  const objectUrl = URL.createObjectURL(file);

  try {
    const stats =
      kind === "video"
        ? await sampleVideoFrame(objectUrl)
        : await sampleImage(objectUrl);
    return resultFromSignals(kind, file.name, file.type, file.size, stats);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function analyzeLink(rawUrl: string): AnalysisResult {
  const normalizedUrl = normalizeUrl(rawUrl);
  const lowered = normalizedUrl.toLowerCase();
  const signals: Signal[] = [];
  let score = 50;

  const matchedDomain = aiDomains.find((domain) => lowered.includes(domain));
  if (matchedDomain) {
    score += 32;
    signals.push({
      label: "Source",
      value: matchedDomain,
      impact: "raises",
      detail: "The link references a known AI media creation service.",
    });
  } else {
    signals.push({
      label: "Source",
      value: "No known generator domain",
      impact: "neutral",
      detail: "The URL does not identify a recognized AI media platform.",
    });
  }

  const matchedTerms = aiTerms.filter((term) => lowered.includes(term));
  if (matchedTerms.length > 0) {
    score += Math.min(22, matchedTerms.length * 8);
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
      detail: "A clean URL is not evidence of authenticity by itself.",
    });
  }

  if (looksLikeSocialVideo(lowered)) {
    score -= 4;
    signals.push({
      label: "Distribution",
      value: "Social/video platform",
      impact: "neutral",
      detail: "Platforms can host both captured and generated content.",
    });
  }

  return {
    score: clampScore(score),
    verdict: verdictForScore(score),
    confidence: matchedDomain || matchedTerms.length > 1 ? "Medium" : "Low",
    watermarkStatus: "Not checked",
    provenanceStatus: "Not checked",
    summary:
      "This link-only result is based on source and URL evidence. A production detector should fetch media server-side, inspect content credentials, and run provider watermark checks when available.",
    signals,
  };
}

function resultFromSignals(
  kind: Exclude<MediaKind, "link">,
  name: string,
  mimeType: string,
  size: number,
  stats: PixelStats,
): AnalysisResult {
  const signals: Signal[] = [];
  let score = 50;
  const loweredName = name.toLowerCase();
  const matchedTerms = aiTerms.filter((term) => loweredName.includes(term));

  if (matchedTerms.length > 0) {
    score += Math.min(18, matchedTerms.length * 7);
    signals.push({
      label: "Filename",
      value: matchedTerms.slice(0, 3).join(", "),
      impact: "raises",
      detail: "The filename includes terms frequently used in generated media exports.",
    });
  } else {
    signals.push({
      label: "Filename",
      value: "No AI terms found",
      impact: "neutral",
      detail: "The filename does not provide a useful authenticity signal.",
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

  const fileSizeMb = size / 1024 / 1024;
  if (kind === "video" && fileSizeMb < 4) {
    score += 5;
    signals.push({
      label: "Container",
      value: `${fileSizeMb.toFixed(1)} MB ${mimeType || "video"}`,
      impact: "raises",
      detail: "Small exported clips are common from generators, but this is a weak signal.",
    });
  } else {
    signals.push({
      label: "Container",
      value: `${fileSizeMb.toFixed(1)} MB ${mimeType || kind}`,
      impact: "neutral",
      detail: "File container details alone are not enough to establish origin.",
    });
  }

  const clampedScore = clampScore(score);

  return {
    score: clampedScore,
    verdict: verdictForScore(clampedScore),
    confidence:
      clampedScore >= 75 || clampedScore <= 28
        ? "Medium"
        : "Low",
    watermarkStatus: "Not detected",
    provenanceStatus: "Missing",
    summary:
      "No cryptographic provenance or supported watermark was verified in this browser prototype. The score is a heuristic estimate from filename, container, and sampled visual features.",
    signals,
  };
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

function normalizeUrl(rawUrl: string) {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function looksLikeSocialVideo(url: string) {
  return [
    "youtube.com",
    "youtu.be",
    "tiktok.com",
    "instagram.com",
    "vimeo.com",
    "x.com",
    "twitter.com",
  ].some((domain) => url.includes(domain));
}

function sampleImage(src: string): Promise<PixelStats> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      resolve(statsFromDrawable(image, image.naturalWidth, image.naturalHeight));
    };
    image.onerror = () => reject(new Error("Could not read the image."));
    image.src = src;
  });
}

function sampleVideoFrame(src: string): Promise<PixelStats> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";

    const cleanup = () => {
      video.removeAttribute("src");
      video.load();
    };

    video.onloadedmetadata = () => {
      const target = Number.isFinite(video.duration)
        ? Math.min(Math.max(video.duration * 0.25, 0.1), 2.5)
        : 0.1;
      video.currentTime = target;
    };

    video.onseeked = () => {
      try {
        const stats = statsFromDrawable(video, video.videoWidth, video.videoHeight);
        cleanup();
        resolve(stats);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    video.onerror = () => {
      cleanup();
      reject(new Error("Could not read the video frame."));
    };

    video.src = src;
  });
}

function statsFromDrawable(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): PixelStats {
  const maxSide = 96;
  const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas is unavailable.");

  context.drawImage(source, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const bins = new Array<number>(32).fill(0);
  const luminance = new Float32Array(width * height);
  let saturationSum = 0;

  for (let i = 0, pixel = 0; i < pixels.length; i += 4, pixel += 1) {
    const r = pixels[i] / 255;
    const g = pixels[i + 1] / 255;
    const b = pixels[i + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    luminance[pixel] = luma;
    saturationSum += max === 0 ? 0 : (max - min) / max;
    bins[Math.min(31, Math.floor(luma * 32))] += 1;
  }

  let entropy = 0;
  const count = width * height;
  for (const bin of bins) {
    if (bin === 0) continue;
    const probability = bin / count;
    entropy -= probability * Math.log2(probability);
  }

  let edgeHits = 0;
  let edgeSum = 0;
  let comparisons = 0;

  for (let y = 1; y < height; y += 1) {
    for (let x = 1; x < width; x += 1) {
      const index = y * width + x;
      const dx = Math.abs(luminance[index] - luminance[index - 1]);
      const dy = Math.abs(luminance[index] - luminance[index - width]);
      const delta = dx + dy;
      edgeSum += delta;
      comparisons += 1;
      if (delta > 0.18) edgeHits += 1;
    }
  }

  const edgeDensity = comparisons === 0 ? 0 : edgeHits / comparisons;
  const compressionProxy = comparisons === 0 ? 0 : edgeSum / comparisons;

  return {
    colorEntropy: entropy,
    edgeDensity,
    smoothness: 1 - Math.min(1, compressionProxy * 3.6),
    saturation: saturationSum / count,
    compressionProxy,
  };
}
