# DTXmaniaNX Web (WebXR rewrite)

TypeScript rewrite of DTXmaniaNX targeting browsers + Quest 3 via WebXR.

This directory lives alongside the original C# codebase (`DTXMania/`, `FDK/`, etc.) and does not modify it. See `/root/.claude/plans/quest3-webxr-dtx-dtxc-discord-plugin-cr-swirling-crayon.md` for the full plan.

## Layout

```
packages/
  dtx-core/       # Pure logic: DTX parser, timing, scoring, scanner. No browser APIs.
  audio-engine/   # (Phase 2) Web Audio + AudioWorklet
  input/          # (Phase 2) Keyboard / Gamepad / XR input
  app-web/        # (Phase 2) Vite + Three.js app
```

## Dev

```sh
pnpm install
pnpm -r test
pnpm -r typecheck
```

## Scope

v1 focuses on DTX drum play. BMS/GDA/G2D, `.dtxc` cache, Discord, plugins, DTXCreator, guitar/bass, and AVI playback are out of scope.
