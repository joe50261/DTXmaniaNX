/**
 * Unit tests for XrLayerManager's fallback-path state machine.
 *
 * The actual GL blit + layer creation requires a real WebGL2 context
 * and an active XR session, neither of which exist in happy-dom; those
 * paths are covered by Quest hardware testing in a future Playwright
 * + WebXR-emulator pass. What we CAN cheaply assert is the
 * fallback-safety invariants: attach() must return false (and
 * isActive() must stay false) whenever three.js didn't negotiate the
 * 'layers' feature, and registerPanel() must refuse to mutate any
 * mesh material in that state.
 */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { XrLayerManager } from './xr-layer-manager.js';

function fakeRendererWithoutBinding(): THREE.WebGLRenderer {
  return {
    xr: {
      getBinding: () => null,
      getBaseLayer: () => null,
    },
    getContext: () => ({} as WebGL2RenderingContext),
    resetState: vi.fn(),
  } as unknown as THREE.WebGLRenderer;
}

function fakePanelMesh(): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ transparent: false, opacity: 1 }),
  );
}

describe('XrLayerManager fallback', () => {
  it('attach returns false when binding is unavailable', () => {
    const mgr = new XrLayerManager();
    const ok = mgr.attach(fakeRendererWithoutBinding(), {} as XRSession);
    expect(ok).toBe(false);
    expect(mgr.isActive()).toBe(false);
  });

  it('registerPanel is a no-op while inactive — mesh material untouched', () => {
    const mgr = new XrLayerManager();
    const mesh = fakePanelMesh();
    const ok = mgr.registerPanel({
      canvas: document.createElement('canvas'),
      mesh,
      refSpace: {} as XRReferenceSpace,
      position: { x: 0, y: 0, z: 0 },
      widthMeters: 1,
      heightMeters: 1,
    });
    expect(ok).toBe(false);
    const mat = mesh.material as THREE.MeshBasicMaterial;
    expect(mat.opacity).toBe(1);
    expect(mat.transparent).toBe(false);
  });

  it('blit before attach is a no-op (no throw)', () => {
    const mgr = new XrLayerManager();
    expect(() => mgr.blit({} as XRFrame)).not.toThrow();
  });

  it('dispose without attach is idempotent', () => {
    const mgr = new XrLayerManager();
    expect(() => mgr.dispose()).not.toThrow();
    expect(() => mgr.dispose()).not.toThrow();
    expect(mgr.isActive()).toBe(false);
  });
});
