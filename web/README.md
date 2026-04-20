# DTXmaniaNX Web (WebXR rewrite)

TypeScript rewrite of DTXmaniaNX targeting browsers + Quest 3 via WebXR.

This directory lives alongside the original C# codebase (`DTXMania/`, `FDK/`, etc.) and does not modify it. See `/root/.claude/plans/quest3-webxr-dtx-dtxc-discord-plugin-cr-swirling-crayon.md` for the full plan.

## Layout

```
packages/
  dtx-core/       # Pure logic: DTX parser, timing, scoring, scanner. No browser APIs.
  audio-engine/   # Web Audio + synthesized drum kit (WAV loading is TODO)
  input/          # Keyboard input (Gamepad / XR controllers TODO)
  app-web/        # Vite app. Canvas-2D rhythm game prototype with bundled demo chart.
```

## Dev

### Toolchain

Node 22 + pnpm 9 are pinned via the `volta` field in `package.json`.

**If you already have pnpm** (Corepack, Homebrew, etc.): just `pnpm install`.

**If you only have [Volta](https://volta.sh/)**: one-time setup, then Volta
auto-switches to the pinned versions whenever you `cd` into `web/`:

```sh
volta install pnpm@9        # one-time, Volta fetches Node 22 automatically on first use
```

### Commands

```sh
cd web
pnpm install
pnpm -r test           # 52 unit/e2e tests (dtx-core)
pnpm -r typecheck      # all packages
pnpm --filter @dtxmania/app-web dev      # http://localhost:5173/
pnpm --filter @dtxmania/app-web build    # prod bundle in packages/app-web/dist
```

### Playing

Two paths:

- **Pick folder** — opens a File System Access API directory picker. Select your
  `DTXmaniaNX/Songs/` (or any folder with `.dtx` charts / `set.def` song groups).
  The directory handle is persisted in IndexedDB, so revisits only need a
  one-click permission re-grant. Requires Chromium-based browsers (Chrome, Edge,
  Quest Browser).
- **Play bundled demo** — plays the built-in 4-measure chart at
  `packages/app-web/public/demo.dtx` (mid-song BPM change). Works in any
  browser.

Default keys: S/D = Snare, Space = Bass, H = HiHat, J = Left Cymbal, F = Crash,
U/O = HiTom, A/P = LoTom, G = FloorTom, K = Open HH. Escape returns to the
library. Drum sounds are synthesized in this preview; real WAV samples are a
later milestone.

### PWA

The app ships a `manifest.webmanifest` + minimal service worker, so it's
installable to the home screen / Quest library. The service worker uses
cache-first for the app shell and network-first for everything else (so fresh
JS is always pulled when online). In dev (`vite`) the SW is intentionally not
registered.

## Status

- ✅ DTX parsing (metadata, WAV/BPM tables, chip lines, hex ch.03, #BASEBPM)
- ✅ Timing (mid-measure BPM changes, multi-measure gaps)
- ✅ Scoring (judgment windows + 1M-point simplified score)
- ✅ Scanner + FS Access API backend + IndexedDB handle persistence
- ✅ Playable Canvas 2D prototype: falling notes, keyboard hits, judgment flashes, HUD
- ✅ PWA manifest + service worker (installable, offline shell)
- 🚧 WAV sample playback (synth drums only for now)
- 🚧 Three.js renderer (Canvas 2D today; upgrades to Three.js for XR)
- 🚧 XR session + Touch controllers
- 🚧 Capacitor APK packaging

## Deploy (GitHub Pages)

Every push to `master` runs `.github/workflows/deploy.yml`, which gates on
`audit:high` + typecheck + tests + build, then publishes
`packages/app-web/dist/` to GitHub Pages. PRs run the same gate without
deploying. Live URL:

    https://joe50261.github.io/DTXmaniaNX/

One-time repo setup: **Settings → Pages → Source: GitHub Actions**.

The Vite `base` is `/DTXmaniaNX/` on GitHub Actions (toggled by
`process.env.GITHUB_ACTIONS`) and `/` for local dev / other CI. All
runtime URL construction goes through `import.meta.env.BASE_URL` and the
service worker derives its shell paths from `self.location`, so the same
source works at either base.

## Security

Dev-dep advisories are caught by two independent layers:

1. **GitHub Dependabot** (alerts + security-update PRs) is enabled on the
   repository — handles detection and triage automatically, no CI needed.
2. **Local `pnpm audit`** for on-demand checks during development:

   ```sh
   pnpm run audit        # moderate+ (current gate)
   pnpm run audit:high   # high+ only, useful for noisy baselines
   ```

There are no runtime third-party deps today (all workspace packages are
`workspace:*`), so the attack surface is limited to the build toolchain
(`vite`, `vitest`, `typescript`). Upgrades that resolve advisories should
preserve the Volta pin in root `package.json` — bump both together.

## Scope

v1 focuses on DTX drum play. BMS/GDA/G2D, `.dtxc` cache, Discord, plugins, DTXCreator, guitar/bass, and AVI playback are out of scope.
