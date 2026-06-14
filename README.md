# Is This AI?

A static Vite/React prototype for media-authenticity triage. Users can upload an image or video, or paste a media link, and receive a transparent AI-generation likelihood score.

The browser prototype separates deterministic verification from heuristic scoring:

- Watermark/provenance checks are shown as their own status.
- Uploaded media is sampled locally for simple color and texture signals.
- Links are scored from available source and naming clues.
- The result explains why it is not a 100% determination unless a supported watermark or provenance signal is verified.

## Development

```sh
npm install
npm run dev
```

## Build

```sh
npm run build
```

## Deployment

The repository is configured for GitHub Pages. Push to `main` and the Pages workflow builds the static app to:

```text
https://bpollak.github.io/is-this-ai/
```
