/* present.js - getting pixels out of the shared heap onto the screen.
 *
 * The engine renders RGBA words (0xFFRRGGBB) into a plain buffer in the shared
 * heap and bumps a sequence counter. The page thread polls that counter and
 * uploads a *view* of the same memory - no copy at all. WebGL2 has no packed
 * 8_8_8_8_REV type for texImage2D, so the byte order is fixed in the fragment
 * shader instead, which is cheaper than any swizzle loop on the CPU.
 *
 * That is the software-renderer version of what the GTA V build did one level
 * up: the engine keeps speaking its original GPU API (D3D11 there, a pixel
 * buffer here) and something on the other side replays it onto WebGPU/WebGL.
 */

window.dgPresent = (function () {
  const stats = {
    frames: 0, frame_seq: 0, keyevents: 0, started: 0, last: 0, quit: 0,
    resx: 0, resy: 0, fb: 0, sleeps: 0, tickcalls: 0, keypolls: 0, assets_ready: 0
  };
  let canvas, gl = null, tex = null, ctx2d = null;
  let statsAddr = 0, lastSeq = 0, inited = false;
  let texW = 0, texH = 0;
  let uploads = 0, uploadMs = 0;

  function read() {
    const u32 = Module.HEAPU32;          // re-read: the heap may have grown
    const b = statsAddr >>> 2;
    stats.frames = u32[b + 0];
    stats.frame_seq = u32[b + 1];
    stats.keyevents = u32[b + 2];
    stats.started = u32[b + 3];
    stats.last = u32[b + 4];
    stats.quit = u32[b + 5];
    stats.resx = u32[b + 6];
    stats.resy = u32[b + 7];
    stats.fb = u32[b + 8];
    stats.sleeps = u32[b + 9];
    stats.tickcalls = u32[b + 10];
    stats.keypolls = u32[b + 11];
    stats.assets_ready = u32[b + 12];
    return stats;
  }

  function initGL() {
    gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: false });
    if (!gl) return false;
    const vs = `#version 300 es
      in vec2 p; out vec2 uv;
      void main(){ uv = vec2((p.x+1.0)*0.5, (1.0-(p.y+1.0)*0.5)); gl_Position = vec4(p,0.0,1.0); }`;
    const fs = `#version 300 es
      precision mediump float; in vec2 uv; uniform sampler2D t; out vec4 o;
      /* the heap holds B,G,R,A, so swap on the way out - free, and it keeps the
       * upload a zero-copy view of the engine's own buffer */
      void main(){ vec4 c = texture(t, uv); o = vec4(c.b, c.g, c.r, 1.0); }`;
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error('shader', gl.getShaderInfoLog(s)); return false; }
      gl.attachShader(prog, s);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.error('link', gl.getProgramInfoLog(prog)); return false; }
    gl.useProgram(prog);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    for (const [k, v] of Object.entries({
      TEXTURE_MIN_FILTER: gl.NEAREST, TEXTURE_MAG_FILTER: gl.NEAREST,
      TEXTURE_WRAP_S: gl.CLAMP_TO_EDGE, TEXTURE_WRAP_T: gl.CLAMP_TO_EDGE
    })) gl.texParameteri(gl.TEXTURE_2D, gl[k], v);
    return true;
  }

  function upload(ptr, w, h) {
    const t0 = performance.now();
    /* a view, not a copy: the driver reads straight out of the wasm heap */
    const view = Module.HEAPU8.subarray(ptr, ptr + w * h * 4);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (w !== texW || h !== texH) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, view);
      texW = w; texH = h;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, view);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    uploads++;
    uploadMs = performance.now() - t0;
  }

  return {
    stats,
    init(cv) {
      canvas = cv;
      statsAddr = Module.ccall('dg_stats_addr', 'number', []);
      stats.resx = Module.ccall('dg_resx', 'number', []);
      stats.resy = Module.ccall('dg_resy', 'number', []);
      canvas.width = stats.resx;
      canvas.height = stats.resy;
      if (!initGL()) {
        console.warn('no WebGL2, falling back to 2D canvas');
        ctx2d = canvas.getContext('2d');
      }
      inited = true;
      window.doomStats = stats;
      return { w: stats.resx, h: stats.resy, gl: !!gl };
    },
    /* threaded build: the page thread polls for new frames */
    poll() {
      if (!inited) return false;
      read();
      if (stats.frame_seq === lastSeq) return false;
      lastSeq = stats.frame_seq;
      if (!stats.fb) return false;
      if (gl) upload(stats.fb, stats.resx, stats.resy);
      else if (ctx2d) {
        const src = new Uint32Array(Module.HEAPU8.buffer, stats.fb, stats.resx * stats.resy);
        const img = ctx2d.createImageData(stats.resx, stats.resy);
        const dst = new Uint32Array(img.data.buffer);
        /* ImageData wants R,G,B,A bytes, i.e. 0xFFBBGGRR - swap the two fields */
        for (let i = 0; i < src.length; i++) {
          const c = src[i];
          dst[i] = (c & 0xff00ff00) | ((c << 16) & 0x00ff0000) | ((c >>> 16) & 0x000000ff);
        }
        ctx2d.putImageData(img, 0, 0);
      }
      return true;
    },
    /* single-threaded build: the engine calls this directly */
    force() { read(); lastSeq = stats.frame_seq; if (stats.fb && gl) upload(stats.fb, stats.resx, stats.resy); },
    perf() { return { uploads, uploadMs }; }
  };
})();

window.dg_present_frame = function () { window.dgPresent.force(); };
window.dg_present_poll = function () { window.dgPresent.poll(); };
