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

The demo app loads `packages/app-web/public/demo.dtx` (a 4-measure drum chart
with a mid-song BPM change). Click Start to unlock audio, then play with
the DTXMania default keys (S/D = Snare, Space = Bass, H = HiHat, J = LC, F = Crash, etc).

## Status (MVP)

- ✅ DTX parsing (metadata, WAV/BPM tables, chip lines, hex ch.03, #BASEBPM)
- ✅ Timing (mid-measure BPM changes, multi-measure gaps)
- ✅ Scoring (judgment windows + 1M-point simplified score)
- ✅ Scanner (abstract FS, set.def, recursive walk)
- ✅ MVP playable: falling notes, keyboard hits, judgment flashes, combo/score HUD
- 🚧 Three.js renderer (Canvas 2D in MVP; plan upgrades to Three.js for XR)
- 🚧 WAV sample playback (synth drums only for now)
- 🚧 XR session + Touch controllers
- 🚧 Capacitor APK packaging

## Scope

v1 focuses on DTX drum play. BMS/GDA/G2D, `.dtxc` cache, Discord, plugins, DTXCreator, guitar/bass, and AVI playback are out of scope.
