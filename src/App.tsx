import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  FileImage,
  Gauge,
  ImageUp,
  Link2,
  Loader2,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  Upload,
  Video,
  X,
} from "lucide-react";
import { analyzeFile, analyzeLink, type AnalysisResult } from "./analyzer";

type Mode = "upload" | "link";
type Preview = {
  url: string;
  type: "image" | "video";
  name: string;
};

const acceptedMedia = "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm";

export function App() {
  const [mode, setMode] = useState<Mode>("upload");
  const [url, setUrl] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [analysisSource, setAnalysisSource] = useState<Mode | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);

  const scoreLabel = useMemo(() => {
    if (!result) return "Awaiting media";
    if (result.score >= 76) return "AI likely";
    if (result.score <= 30) return "Human likely";
    return "Not settled";
  }, [result]);

  const uploadGuidance = useMemo(() => {
    if (isAnalyzing && analysisSource === "upload") {
      return "Sampling video/image signals in your browser.";
    }
    if (selectedFile) return "Ready to analyze this uploaded file.";
    return "Choose an image or video, then click Analyze media.";
  }, [analysisSource, isAnalyzing, selectedFile]);

  const linkNotice = useMemo(() => getSocialLinkNotice(url), [url]);

  function handleFile(file: File | undefined) {
    if (!file) return;
    setError("");

    if (!file.type.startsWith("image") && !file.type.startsWith("video")) {
      setError("Upload an image or video file.");
      return;
    }

    if (preview) URL.revokeObjectURL(preview.url);
    const nextPreview = {
      url: URL.createObjectURL(file),
      type: file.type.startsWith("video") ? "video" as const : "image" as const,
      name: file.name,
    };
    setSelectedFile(file);
    setPreview(nextPreview);
    setResult(null);
    setAnalysisSource(null);
  }

  async function handleAnalyzeSelectedFile() {
    if (!selectedFile) {
      setError("Choose an image or video file first.");
      return;
    }

    setError("");
    setResult(null);
    setAnalysisSource("upload");
    setIsAnalyzing(true);

    try {
      setResult(await analyzeFile(selectedFile));
    } catch (analysisError) {
      setError(
        analysisError instanceof Error
          ? analysisError.message
          : "The media could not be analyzed.",
      );
    } finally {
      setIsAnalyzing(false);
    }
  }

  function handleDrop(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    handleFile(event.dataTransfer.files[0]);
  }

  function handleUrlSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPreview(null);
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";

    if (!url.trim()) {
      setError("Paste a media link first.");
      return;
    }

    setAnalysisSource("link");
    setIsAnalyzing(true);
    window.setTimeout(() => {
      setResult(analyzeLink(url));
      setIsAnalyzing(false);
    }, 280);
  }

  function reset() {
    setUrl("");
    setSelectedFile(null);
    setResult(null);
    setAnalysisSource(null);
    setError("");
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <main className="app-shell">
      <section className="workspace" aria-label="AI media authenticity checker">
        <header className="topbar">
          <div>
            <p className="eyebrow">Media provenance triage</p>
            <h1>Is This AI?</h1>
          </div>
          <div className="status-pill">
            <ShieldCheck size={18} aria-hidden="true" />
            SynthID / C2PA ready model
          </div>
        </header>

        <div className="layout">
          <section className="input-panel" aria-label="Submit media">
            <div className="segmented" role="tablist" aria-label="Submission type">
              <button
                className={mode === "upload" ? "active" : ""}
                onClick={() => setMode("upload")}
                type="button"
                role="tab"
                aria-selected={mode === "upload"}
              >
                <Upload size={17} aria-hidden="true" />
                Upload
              </button>
              <button
                className={mode === "link" ? "active" : ""}
                onClick={() => setMode("link")}
                type="button"
                role="tab"
                aria-selected={mode === "link"}
              >
                <Link2 size={17} aria-hidden="true" />
                Link
              </button>
            </div>

            {mode === "upload" ? (
              <label
                className="dropzone"
                onDragOver={(event) => event.preventDefault()}
                onDrop={handleDrop}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={acceptedMedia}
                  onChange={(event) => handleFile(event.target.files?.[0])}
                />
                <span className="drop-icon">
                  <ImageUp size={30} aria-hidden="true" />
                </span>
                <strong>Drop media or choose a file</strong>
                <span>Images and short videos are sampled in your browser.</span>
              </label>
            ) : (
              <form className="link-form" onSubmit={handleUrlSubmit}>
                <label htmlFor="media-url">Video or image link</label>
                <div className="url-row">
                  <input
                    id="media-url"
                    type="url"
                    value={url}
                    placeholder="https://..."
                    onChange={(event) => setUrl(event.target.value)}
                  />
                  <button type="submit">
                    <ScanSearch size={18} aria-hidden="true" />
                    Analyze
                  </button>
                </div>
                {linkNotice ? (
                  <p className="social-notice" aria-live="polite">
                    <AlertTriangle size={17} aria-hidden="true" />
                    {linkNotice}
                  </p>
                ) : null}
              </form>
            )}

            {mode === "upload" ? (
              <div className="upload-action-row">
                <p aria-live="polite">{uploadGuidance}</p>
                <button
                  type="button"
                  className="primary-action"
                  onClick={() => void handleAnalyzeSelectedFile()}
                  disabled={!selectedFile || isAnalyzing}
                >
                  {isAnalyzing && analysisSource === "upload" ? (
                    <Loader2 className="spin" size={18} aria-hidden="true" />
                  ) : (
                    <ScanSearch size={18} aria-hidden="true" />
                  )}
                  {isAnalyzing && analysisSource === "upload" ? "Analyzing..." : "Analyze media"}
                </button>
              </div>
            ) : null}

            {error ? (
              <div className="alert" role="alert">
                <AlertTriangle size={18} aria-hidden="true" />
                {error}
              </div>
            ) : null}

            <div className="preview-stage">
              {preview ? (
                <>
                  <div className="preview-toolbar">
                    <span>
                      {preview.type === "video" ? (
                        <Video size={16} aria-hidden="true" />
                      ) : (
                        <FileImage size={16} aria-hidden="true" />
                      )}
                      {preview.name}
                    </span>
                    <button type="button" onClick={reset} aria-label="Clear media">
                      <X size={16} aria-hidden="true" />
                    </button>
                  </div>
                  {preview.type === "video" ? (
                    <video src={preview.url} controls />
                  ) : (
                    <img src={preview.url} alt={preview.name} />
                  )}
                </>
              ) : (
                <div className="empty-preview">
                  <div className="scan-visual" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                  <p>Submitted media appears here for review.</p>
                </div>
              )}
            </div>
          </section>

          <section className="result-panel" aria-label="Analysis result">
            <div className="result-header">
              <div>
                <p className="eyebrow">Current answer</p>
                <h2>{isAnalyzing ? "Analyzing..." : result?.verdict ?? "No result yet"}</h2>
              </div>
              <button type="button" className="icon-button" onClick={reset} aria-label="Reset">
                <RotateCcw size={18} aria-hidden="true" />
              </button>
            </div>

            <div className="meter-block">
              <div
                className="meter"
                style={{ "--score": `${result?.score ?? 50}%` } as React.CSSProperties}
                aria-label={`AI likelihood score ${result?.score ?? 0} percent`}
              >
                <div className="meter-fill" />
                <div className="meter-pointer" />
              </div>
              <div className="score-row">
                <span>{scoreLabel}</span>
                <strong>{result ? `${result.score}%` : "--"}</strong>
              </div>
            </div>

            <div className="verification-grid">
              <Metric
                icon={<BadgeCheck size={18} aria-hidden="true" />}
                label="Watermark"
                value={result?.watermarkStatus ?? "Not checked"}
              />
              <Metric
                icon={<ShieldCheck size={18} aria-hidden="true" />}
                label="Provenance"
                value={result?.provenanceStatus ?? "Not checked"}
              />
              <Metric
                icon={<Gauge size={18} aria-hidden="true" />}
                label="Confidence"
                value={result?.confidence ?? "None"}
              />
            </div>

            <p className="summary">
              {isAnalyzing ? (
                <>
                  <Loader2 className="spin" size={17} aria-hidden="true" />
                  {analysisSource === "upload"
                    ? "Sampling video/image signals in your browser."
                    : "Reading available link and source signals."}
                </>
              ) : (
                result?.summary ??
                (mode === "upload"
                  ? "Choose a file, then click Analyze media to get a transparent likelihood score."
                  : "Submit a link to get URL-only triage. Upload the actual file for visual analysis.")
              )}
            </p>

            <div className="signal-list" aria-label="Evidence signals">
              {(result?.signals ?? placeholderSignals).map((signal) => (
                <article className="signal" data-impact={signal.impact} key={signal.label}>
                  <div>
                    <span>{signal.label}</span>
                    <strong>{signal.value}</strong>
                  </div>
                  <p>{signal.detail}</p>
                </article>
              ))}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

const placeholderSignals = [
  {
    label: "Watermark",
    value: "Waiting",
    impact: "neutral" as const,
    detail: "Supported watermark checks would override the score when available.",
  },
  {
    label: "Visual sample",
    value: "Waiting",
    impact: "neutral" as const,
    detail: "Uploaded files are sampled locally for simple texture and color signals.",
  },
  {
    label: "Source",
    value: "Waiting",
    impact: "neutral" as const,
    detail: "Links are scored from available source and naming clues.",
  },
];

function getSocialLinkNotice(rawUrl: string) {
  const url = rawUrl.trim().toLowerCase();
  if (!url) return "";

  if (url.includes("instagram.com")) {
    return "Instagram links are URL-only here. To inspect frames, download or save the Reel video and upload the file.";
  }

  if (
    url.includes("tiktok.com") ||
    url.includes("youtube.com") ||
    url.includes("youtu.be") ||
    url.includes("vimeo.com") ||
    url.includes("x.com") ||
    url.includes("twitter.com")
  ) {
    return "Social video links are URL-only here. Upload the actual media file for frame-level analysis.";
  }

  return "";
}
