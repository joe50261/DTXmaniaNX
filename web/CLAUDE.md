# DTXmaniaNX Web — Architecture conventions

Short-form notes that contributors (human or AI) should follow when extending
`web/packages/app-web`. These are the non-obvious load-bearing decisions; the
README covers what the project *is*.

## VR-first

This is a VR rhythm game (Quest 3 is the target device); the desktop build is
a dev fallback and a graceful-degradation path, not the primary UX. When
designing a new feature, **confirm it works in VR first**, then add a desktop
view if one is useful. "We'll bolt on VR later" is what produced the R1–R6
refactor debt — don't repeat it.

## In-play overlay UI goes on `paintHud()` canvas, not DOM

Any visual feedback that appears *during* gameplay — toasts, pop-ups, debug
banners, countdowns, etc. — should be painted on the shared HUD canvas
(`Renderer.paintHud` in `src/renderer.ts`), not implemented as a DOM element.

**Why it matters**: the HUD canvas is the texture source for both the desktop
ortho quad *and* the VR floating playfield panel. Drawing on it automatically
gives you VR support; a DOM element is invisible inside an immersive WebXR
session.

**The pattern**:

1. Add the visual's state to `RenderState` in `renderer.ts` (text, expiry,
   colour, whatever). Let the model clear itself on expiry so writers don't
   need timers.
2. Writers (hotkeys in `main.ts`, game events in `game.ts`, controllers in
   `xr-controllers.ts`) call a small module like `hud-toast.ts`
   (`showToast(text)`) that stashes the state in a module-level singleton.
3. `Game.buildRenderState()` reads the singleton and puts the value into
   `RenderState` each frame.
4. `Renderer.paintHud` draws the visual as the last step (so it sits on top
   of chips/judgement/result).

Example: the mid-play toast (`hud-toast.ts` + `RenderState.toast` +
`Renderer.drawToast`) — previously a `#hud-toast` DOM element that was
invisible in VR, now canvas-based and visible in both.

**When DOM is the right call**: modals that need HTML a11y / text input
(song picker search box, settings panel with typed values), things that need
to exist before the renderer is up (loading screen, error overlay).
Everything else: canvas.

## Pure model modules for shared logic

When a piece of logic (constants, state-transition functions, data shapes)
is used by both the desktop DOM view and the VR canvas view, move it into
a `*-model.ts` module that depends on nothing view-specific. The views then
become thin subscribers. Examples:

- `song-wheel-model.ts` — shared by `song-wheel.ts` (DOM) and `vr-menu.ts`
  (canvas). Constants like `WHEEL_VISIBLE_ROWS`, the `DisplayEntry` type,
  `buildDisplayEntries()`, `cycleFocus()`, `buildBreadcrumbPath()`, etc.

Don't copy-paste navigation logic into the VR view "because it's shorter" —
the two *will* drift and you'll be chasing subtle bugs six weeks later.

## Test the model, not the view

Testing policy — every change ships with coverage. Pick the cheapest
realistic test that catches the specific regression; mock only when
it's demonstrably cheaper than the alternative and doesn't re-implement
the code under test.

- **Pure model functions** (`song-wheel-model.ts`, `hud-toast.ts`,
  `tick-state.ts`, `vr-menu-input.ts`, `vr-lifecycle.ts`, …) → **unit
  tests** (`*.test.ts` via `vitest`). Full branch coverage expected;
  no DOM / canvas / Three.js dependencies, so they're cheap.
- **Pure geometry / layout constants** exported from view modules
  (`VR_MENU_FOOTER`, `VR_CONFIG_LAYOUT`) → **unit tests** that pin the
  geometric invariants (non-overlap, in-bounds).
- **Canvas-2D panel code** (VR menu, VR config, VR calibrate — paint
  to a plain `HTMLCanvasElement` that's then wrapped into a
  `THREE.CanvasTexture`) → **unit tests with a fake Three.js
  renderer**. The canvas itself is real happy-dom; `webgl.xr.getController`
  and friends are stubbed the way `xr-controllers.test.ts` does it.
  You can exercise paint → inspect the class's `hits` array →
  simulate a click by calling the action — no WebGL context needed.
- **Three.js scene construction + WebGL render** → **Playwright e2e**
  against `pnpm preview`. Use this when the regression depends on real
  browser text metrics, image decoding, or GL state. Don't reinvent
  the renderer in jsdom.
- **WebXR flows** (controller poses, session lifecycle) → the
  pose-resolution decision goes in a pure helper (see
  `resolveHapticSource`, `emptyChartState`) that IS unit-testable; the
  wiring around it is covered by the fake-renderer canvas tests above
  or Chrome's WebXR Device Emulator in a future e2e pass.

Anti-patterns to avoid: hand-rolling a `measureText` polyfill to make
happy-dom match Chromium layout, mocking `THREE.Mesh` field-by-field
so a test can assert on internal state, or writing a test whose
assertions are satisfied by any implementation that compiles. If the
mock is longer than the code it's testing, do it in Playwright
instead.

## Branch expectations

Default development branch is whatever the session is assigned to. Do not
push to `master` directly; open a PR. Never use `--no-verify` to skip hooks.
