# Is This AI?

A Vite/React prototype for media-authenticity triage. Users can upload an image or video, or paste a media link, and receive a transparent AI-generation likelihood score.

The browser prototype separates deterministic verification from heuristic scoring:

- Watermark/provenance checks are shown as their own status.
- Uploaded media is previewed first, then sampled locally after the user clicks **Analyze media**.
- Links are resolved through `/api/analyze-url` when the app runs on Vercel. Social video links, including Instagram Reels, TikToks, YouTube Shorts, Vimeo, X/Twitter, Facebook, and Threads videos, need backend resolution before frame analysis.
- GitHub Pages remains a static fallback: uploads still work in the browser, but social links are metadata-only without the Vercel backend.
- The result explains why it is not a 100% determination unless a supported watermark or provenance signal is verified.

## Development

```sh
npm install
npm run dev
```

The Vite dev server does not run Vercel functions. Use Vercel locally when testing social URL resolution:

```sh
npx vercel dev
```

## Build

```sh
npm run build
```

## Deployment

The repository is still configured for GitHub Pages as a static upload/link-triage fallback. Push to `main` and the Pages workflow builds the static app to:

```text
https://bpollak.github.io/is-this-ai/
```

For social-media link analysis, deploy the same repository to Vercel. Vercel runs `api/analyze-url.ts`, which can:

- accept a social URL,
- call a configured social media resolver service,
- download the resolver's returned media URL with size/time limits,
- extract a video frame with ffmpeg or sample a resolved image/thumbnail, and
- return an explicit inspection status such as `Resolved media`, `Representative frame`, or `Metadata only`.

### Vercel environment variables

```text
SOCIAL_RESOLVER_ENDPOINT=https://your-resolver.example/analyze
SOCIAL_RESOLVER_API_KEY=...
META_APP_ID=...
META_APP_SECRET=...
```

`SOCIAL_RESOLVER_ENDPOINT` is required for arbitrary Instagram/Reels media extraction. Meta oEmbed can provide metadata or thumbnails for some Instagram posts when `META_APP_ID` and `META_APP_SECRET` are set, but it does not provide arbitrary downloadable Reel video bytes.
