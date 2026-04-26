// dependency-cruiser config — see https://github.com/sverweij/dependency-cruiser
//
// The rules below freeze the project's import conventions so the
// canvas / pure-model split stays clean as we add features.

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular dependencies tangle initialisation order and break tree-shaking.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment:
        'Modules without any incoming edges (excluding entrypoints) usually mean dead code.',
      from: {
        orphan: true,
        pathNot: [
          // Vite entrypoints / build inputs
          '\\.(d\\.ts|test\\.ts|spec\\.ts)$',
          'main\\.ts$',
          'sw\\.ts$',
          'vite\\.config\\.ts$',
          // Type-only re-exports may legitimately be orphans of the
          // graph dep-cruiser sees.
          '\\.config\\.(c|m)?js$',
        ],
      },
      to: {},
    },
    {
      name: 'not-to-test',
      severity: 'error',
      comment:
        'Production code must not import test fixtures or specs — they pull in vitest at runtime.',
      from: { pathNot: '\\.(test|spec)\\.(ts|tsx|js)$' },
      to: { path: '\\.(test|spec)\\.(ts|tsx|js)$' },
    },
    {
      name: 'no-deprecated-core',
      severity: 'warn',
      comment: "Avoid Node.js core APIs that are slated for removal.",
      from: {},
      to: { dependencyTypes: ['deprecated'] },
    },
    {
      name: 'pure-model-no-view-imports',
      severity: 'error',
      comment:
        'Files matching `*-model.ts` must stay framework-free so they can be cheaply unit-tested. ' +
        'Importing a *-canvas / renderer / DOM-bound module breaks that contract.',
      from: { path: 'packages/app-web/src/.*-model\\.ts$', pathNot: '\\.test\\.ts$' },
      to: {
        path: [
          'packages/app-web/src/.*-canvas\\.ts$',
          'packages/app-web/src/renderer\\.ts$',
          'packages/app-web/src/main\\.ts$',
          'packages/app-web/src/game\\.ts$',
          'packages/app-web/src/xr-controllers\\.ts$',
        ],
      },
    },
    {
      name: 'no-three-in-pure-modules',
      severity: 'error',
      comment:
        'Pure helper modules (animations, layout, model, input, calibrate-model, ' +
        'tick-state, vr-lifecycle, on-screen-log-model, hud-toast, song-select-input, ' +
        'song-wheel-model, song-select-animations, song-select-layout) must not import three.js. ' +
        'Three.js belongs in view modules only.',
      from: {
        path: [
          'packages/app-web/src/.*-model\\.ts$',
          'packages/app-web/src/.*-layout\\.ts$',
          'packages/app-web/src/.*-animations\\.ts$',
          'packages/app-web/src/song-select-input\\.ts$',
          'packages/app-web/src/calibrate-model\\.ts$',
          'packages/app-web/src/tick-state\\.ts$',
          'packages/app-web/src/vr-lifecycle\\.ts$',
          'packages/app-web/src/hud-toast\\.ts$',
          'packages/app-web/src/skin-url\\.ts$',
          'packages/app-web/src/scene-state\\.ts$',
        ],
        pathNot: '\\.test\\.ts$',
      },
      to: { path: '^node_modules/three($|/)' },
    },
    {
      name: 'scene-state-no-view-imports',
      severity: 'error',
      comment:
        'scene-state.ts is the pure transition function for app scenes. ' +
        'It must not import view modules so the canvas renderers can ' +
        'depend on it without circles.',
      from: { path: 'packages/app-web/src/scene-state\\.ts$', pathNot: '\\.test\\.ts$' },
      to: {
        path: [
          'packages/app-web/src/.*-canvas\\.ts$',
          'packages/app-web/src/renderer\\.ts$',
          'packages/app-web/src/main\\.ts$',
          'packages/app-web/src/game\\.ts$',
          'packages/app-web/src/xr-controllers\\.ts$',
        ],
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    moduleSystems: ['es6', 'cjs'],
    tsPreCompilationDeps: true,
    // Skip tsConfig — `tsconfig.base.json` lives at the workspace root
    // and the depcruise config resolves `extends` relative to the
    // tsconfig itself, which trips on our nested-package layout.
    // Direct .ts file scanning is enough for the rules below.
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
