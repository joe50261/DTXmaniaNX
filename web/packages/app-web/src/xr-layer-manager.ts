/**
 * WebXR composition-layer manager for canvas-textured panels.
 *
 * Why this exists: a CanvasTexture mapped onto a Mesh and rendered
 * through the projection layer goes through MSAA-resolve and lens
 * distortion before reaching the display. A composition layer
 * (XRQuadLayer) is sampled by the runtime's compositor at near-eye
 * rates with no intermediate eye-buffer pass — text and pixel art
 * stay sharp and chromatic-aberration-free, which is the largest
 * single readability win on Quest.
 *
 * Scope of this module:
 *   - Detects whether the active session has the 'layers' feature
 *     (via `renderer.xr.getBinding()`) and is otherwise a no-op.
 *   - Owns a tiny GLSL pass-through program that blits a HTMLCanvas
 *     into a quad layer's color texture each frame.
 *   - Tracks each registered panel's source canvas + a "shadow" mesh
 *     used for desktop ortho rendering and laser-ray hit-testing in
 *     VR — the mesh stays in the scene, but its material is hidden
 *     while the layer is active so we don't double-render.
 *   - Restores three.js's GL state cache after every blit pass so
 *     the engine's own draw calls aren't poisoned.
 *
 * Fallback path: if construction throws or any per-frame call
 * fails, the manager flips itself off and the panels keep rendering
 * via their existing meshes. That keeps shipping safe for Quest /
 * desktop browsers without layers support without losing the
 * non-VR or pre-layers user experience.
 */
import * as THREE from 'three';
import { recordLayerBlit } from './metrics-model.js';

export interface PanelInit {
  /** Source canvas — same one currently feeding the panel's CanvasTexture. */
  canvas: HTMLCanvasElement;
  /** Shadow mesh used for desktop ortho draw and VR raycast.
   * Manager hides its material while a layer is active. */
  mesh: THREE.Mesh;
  /** Reference space the layer's transform is expressed in. */
  refSpace: XRReferenceSpace;
  /** World position of the panel centre (metres, in refSpace). */
  position: { x: number; y: number; z: number };
  /** World orientation; identity = facing +Z toward the user. */
  orientation?: { x: number; y: number; z: number; w: number };
  /** Panel size in world units (metres). */
  widthMeters: number;
  heightMeters: number;
}

interface RegisteredPanel {
  layer: XRQuadLayer;
  canvas: HTMLCanvasElement;
  mesh: THREE.Mesh;
  /** Saved material opacity so we can restore on dispose. */
  prevOpacity: number;
  prevTransparent: boolean;
  /** GL texture we upload the canvas into each frame; reused. */
  srcTex: WebGLTexture;
  /** Framebuffer reused across frames; layer's color texture is
   * (re)attached every frame because the runtime may rotate it. */
  fbo: WebGLFramebuffer;
  /** Source dimensions cached so we can call texImage2D vs
   * texSubImage2D appropriately when the canvas resizes. */
  texW: number;
  texH: number;
}

/**
 * Vertex + fragment shaders for the canvas → layer blit. ES 3.00
 * because the WebXR Layers API requires WebGL2.
 *
 * The `1.0 - v_uv.y` flip mirrors the canvas's top-left origin to
 * GL's bottom-left, matching how three.js's CanvasTexture sets
 * `flipY = true` by default.
 */
const VERT_SRC = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG_SRC = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 outColor;
void main() {
  outColor = texture(u_tex, vec2(v_uv.x, 1.0 - v_uv.y));
}
`;

export class XrLayerManager {
  private gl: WebGL2RenderingContext | null = null;
  private binding: XRWebGLBinding | null = null;
  private session: XRSession | null = null;
  private projectionLayer: XRProjectionLayer | null = null;
  private renderer: THREE.WebGLRenderer | null = null;

  /** GL handles for the blit pipeline; allocated lazily on first
   * panel registration so attach() stays cheap when no panels opt
   * in. */
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private uTexLoc: WebGLUniformLocation | null = null;
  private quadVbo: WebGLBuffer | null = null;

  private panels: RegisteredPanel[] = [];

  /** True between attach() and dispose(); flips false on irrecoverable
   * blit failure so we silently fall back to mesh rendering. */
  private active = false;

  /**
   * Try to attach to a freshly-started XR session. No-op if three.js
   * didn't create an XRWebGLBinding (i.e. the runtime ignored our
   * 'layers' optional feature or we're on WebGL1).
   */
  attach(renderer: THREE.WebGLRenderer, session: XRSession): boolean {
    const xr = renderer.xr as unknown as {
      getBinding(): XRWebGLBinding | null;
      getBaseLayer(): XRWebGLLayer | XRProjectionLayer;
    };
    const binding = xr.getBinding?.();
    if (!binding) return false; // layers not negotiated
    const baseLayer = xr.getBaseLayer?.();
    if (!baseLayer || !('textureWidth' in baseLayer)) return false;
    const gl = renderer.getContext();
    if (!('createVertexArray' in gl)) return false; // WebGL1 — bail
    this.renderer = renderer;
    this.gl = gl as WebGL2RenderingContext;
    this.session = session;
    this.binding = binding;
    this.projectionLayer = baseLayer as XRProjectionLayer;
    this.active = true;
    return true;
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * Register a panel for layer-promotion. The mesh's material is
   * dimmed to invisible while the layer is active; raycasting still
   * works because we leave `visible=true` and only zero opacity.
   */
  registerPanel(init: PanelInit): boolean {
    if (!this.active || !this.gl || !this.binding) return false;
    try {
      this.ensureBlitPipeline();
      const transform = new XRRigidTransform(
        { x: init.position.x, y: init.position.y, z: init.position.z },
        init.orientation ?? { x: 0, y: 0, z: 0, w: 1 },
      );
      // Layers spec: width/height are HALF-extents (radius from centre).
      const layer = this.binding.createQuadLayer({
        space: init.refSpace,
        viewPixelWidth: init.canvas.width,
        viewPixelHeight: init.canvas.height,
        transform,
        width: init.widthMeters / 2,
        height: init.heightMeters / 2,
        textureType: 'texture',
      });
      const gl = this.gl;
      const srcTex = gl.createTexture();
      const fbo = gl.createFramebuffer();
      if (!srcTex || !fbo) {
        if (srcTex) gl.deleteTexture(srcTex);
        if (fbo) gl.deleteFramebuffer(fbo);
        layer.destroy();
        return false;
      }
      const mat = init.mesh.material as THREE.Material & {
        opacity: number;
        transparent: boolean;
      };
      const prevOpacity = mat.opacity;
      const prevTransparent = mat.transparent;
      mat.transparent = true;
      mat.opacity = 0;
      const panel: RegisteredPanel = {
        layer,
        canvas: init.canvas,
        mesh: init.mesh,
        prevOpacity,
        prevTransparent,
        srcTex,
        fbo,
        texW: 0,
        texH: 0,
      };
      this.panels.push(panel);
      this.appendLayerToRenderState();
      return true;
    } catch (err) {
      console.warn('[xr-layers] registerPanel failed; staying on mesh path', err);
      return false;
    }
  }

  /**
   * Per-frame callback. Pulls each panel's canvas into its layer's
   * color texture. Must be called inside an XR frame (i.e. with
   * `frame` non-null from `setAnimationLoop`'s second arg).
   */
  blit(frame: XRFrame): void {
    if (!this.active || !this.binding || !this.gl) return;
    if (this.panels.length === 0) return;
    const gl = this.gl;
    const blitT0 = performance.now();
    try {
      // Save state we touch — three.js's WebGLState cache will be
      // invalidated via resetState() but we still want minimal
      // poisoning during the pass.
      const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      const prevProgram = gl.getParameter(gl.CURRENT_PROGRAM);
      const prevActive = gl.getParameter(gl.ACTIVE_TEXTURE);
      const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
      const prevDepthTest = gl.getParameter(gl.DEPTH_TEST);
      const prevBlend = gl.getParameter(gl.BLEND);
      const prevCull = gl.getParameter(gl.CULL_FACE);
      const prevScissor = gl.getParameter(gl.SCISSOR_TEST);
      const prevVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
      const prevTex2d = gl.getParameter(gl.TEXTURE_BINDING_2D);
      // three.js's CanvasTexture defaults to flipY=true, so its
      // WebGLState leaves `UNPACK_FLIP_Y_WEBGL` as true after the
      // engine's draw — that would make our canvas land in the
      // texture upside-down and the polyfill's quad-layer compositor
      // (which samples `v=1` at the top of the quad in image
      // convention) display the HUD inverted. Pin both unpack flags
      // to the values our blit shader assumes (`flipY=false`,
      // `premultiplyAlpha=false`) and restore afterwards.
      const prevFlipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
      const prevPremul = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.SCISSOR_TEST);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(this.uTexLoc, 0);

      for (const panel of this.panels) {
        if (panel.layer.needsRedraw === false) {
          // Per spec, runtime sets needsRedraw=true between frames
          // it actually composites; if false we'd still need to
          // re-render, so just always blit — cheap enough.
        }
        const sub = this.binding.getSubImage(panel.layer, frame);
        gl.bindFramebuffer(gl.FRAMEBUFFER, panel.fbo);
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D,
          sub.colorTexture,
          0,
        );
        const w = panel.canvas.width;
        const h = panel.canvas.height;
        gl.viewport(0, 0, w, h);

        gl.bindTexture(gl.TEXTURE_2D, panel.srcTex);
        if (panel.texW !== w || panel.texH !== h) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, panel.canvas);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          panel.texW = w;
          panel.texH = h;
        } else {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, panel.canvas);
        }
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      gl.bindVertexArray(prevVao as WebGLVertexArrayObject | null);
      gl.bindTexture(gl.TEXTURE_2D, prevTex2d as WebGLTexture | null);
      gl.useProgram(prevProgram as WebGLProgram | null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo as WebGLFramebuffer | null);
      gl.activeTexture(prevActive as number);
      gl.viewport(prevViewport[0]!, prevViewport[1]!, prevViewport[2]!, prevViewport[3]!);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, prevFlipY as boolean);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, prevPremul as boolean);
      if (prevDepthTest) gl.enable(gl.DEPTH_TEST);
      if (prevBlend) gl.enable(gl.BLEND);
      if (prevCull) gl.enable(gl.CULL_FACE);
      if (prevScissor) gl.enable(gl.SCISSOR_TEST);
      this.renderer?.resetState();
      recordLayerBlit(performance.now() - blitT0);
    } catch (err) {
      console.warn('[xr-layers] blit failed; falling back to mesh path', err);
      this.deactivate();
    }
  }

  dispose(): void {
    if (!this.gl) return;
    const gl = this.gl;
    for (const panel of this.panels) {
      gl.deleteTexture(panel.srcTex);
      gl.deleteFramebuffer(panel.fbo);
      const mat = panel.mesh.material as THREE.Material & {
        opacity: number;
        transparent: boolean;
      };
      mat.opacity = panel.prevOpacity;
      mat.transparent = panel.prevTransparent;
      try {
        panel.layer.destroy();
      } catch {
        // already destroyed by session end — fine
      }
    }
    this.panels.length = 0;
    if (this.program) gl.deleteProgram(this.program);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.quadVbo) gl.deleteBuffer(this.quadVbo);
    this.program = null;
    this.vao = null;
    this.quadVbo = null;
    this.gl = null;
    this.binding = null;
    this.session = null;
    this.projectionLayer = null;
    this.renderer = null;
    this.active = false;
  }

  /**
   * Inactivate without releasing GL handles. Used when blit() fails
   * mid-session — meshes' materials are restored so the fallback
   * path is visible from the next frame.
   */
  private deactivate(): void {
    for (const panel of this.panels) {
      const mat = panel.mesh.material as THREE.Material & {
        opacity: number;
        transparent: boolean;
      };
      mat.opacity = panel.prevOpacity;
      mat.transparent = panel.prevTransparent;
    }
    this.active = false;
  }

  private ensureBlitPipeline(): void {
    if (this.program || !this.gl) return;
    const gl = this.gl;
    const prog = compileProgram(gl, VERT_SRC, FRAG_SRC);
    const vbo = gl.createBuffer();
    const vao = gl.createVertexArray();
    if (!vbo || !vao) throw new Error('blit pipeline alloc failed');
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    // Two triangles as a strip: (-1,-1) (1,-1) (-1,1) (1,1).
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.bindVertexArray(vao);
    const aPosLoc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPosLoc);
    gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.program = prog;
    this.vao = vao;
    this.quadVbo = vbo;
    const loc = gl.getUniformLocation(prog, 'u_tex');
    if (!loc) throw new Error('u_tex uniform missing');
    this.uTexLoc = loc;
  }

  /**
   * Append our quad layers to the session's render-state layer list,
   * keeping three.js's projection layer at index 0 so the engine's
   * own draws still hit the correct backbuffer.
   *
   * Re-called every time a panel is added so the runtime sees the
   * current set without us having to wait for a full session-state
   * round-trip.
   */
  private appendLayerToRenderState(): void {
    if (!this.session || !this.projectionLayer) return;
    const layers: XRLayer[] = [
      this.projectionLayer,
      ...this.panels.map((p) => p.layer),
    ];
    this.session.updateRenderState({ layers });
  }
}

function compileProgram(
  gl: WebGL2RenderingContext,
  vertSrc: string,
  fragSrc: string,
): WebGLProgram {
  const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram();
  if (!prog) throw new Error('createProgram failed');
  gl.attachShader(prog, vert);
  gl.attachShader(prog, frag);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`program link failed: ${log}`);
  }
  // Once linked, individual shaders can be released.
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  return prog;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('createShader failed');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}`);
  }
  return sh;
}
