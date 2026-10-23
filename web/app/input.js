/* input.js - the feeder layer.
 *
 * Lesson repeated across the 2026 ports (kpwn's BO1 co-op mod is the clearest
 * example): the engine's input *abstraction* usually survives, the OS layer
 * under it does not, so you rewrite the OS layer. Here the engine asks for
 * DOOM keycodes through DG_GetKey; we feed it from the DOM KeyboardEvent
 * stream and from the Gamepad API.
 */

window.dgInput = (function () {
  // DOOM keycodes (doomkeys.h)
  const K = {
    UP: 0xad, DOWN: 0xaf, LEFT: 0xac, RIGHT: 0xae,
    STRAFE_L: 0xa0, STRAFE_R: 0xa1, USE: 0xa2, FIRE: 0xa3,
    ESC: 27, ENTER: 13, TAB: 9, BACKSPACE: 0x7f,
    RSHIFT: 0x80 + 0x36, RCTRL: 0x80 + 0x1d, RALT: 0x80 + 0x38,
    F1: 0x80 + 0x3b, F2: 0x80 + 0x3c, F3: 0x80 + 0x3d, F4: 0x80 + 0x3e,
    F5: 0x80 + 0x3f, F6: 0x80 + 0x40, F7: 0x80 + 0x41, F8: 0x80 + 0x42,
    PREVW: '<'.charCodeAt(0), NEXTW: '>'.charCodeAt(0)
  };

  const MAP = {
    ArrowUp: K.UP, ArrowDown: K.DOWN, ArrowLeft: K.LEFT, ArrowRight: K.RIGHT,
    KeyW: K.UP, KeyS: K.DOWN, KeyA: K.STRAFE_L, KeyD: K.STRAFE_R,
    Space: K.USE, Enter: K.ENTER, Escape: K.ESC, Tab: K.TAB, Backspace: K.BACKSPACE,
    // This engine's fire key is KEY_FIRE (0xa3), not KEY_RCTRL: m_controls.c
    // ships `int key_fire = KEY_FIRE;`. Sending the real Ctrl scancode (0x9d)
    // means the engine sees a key that nothing is bound to, and nothing shoots.
    ControlLeft: K.FIRE, ControlRight: K.FIRE,
    ShiftLeft: K.RSHIFT, ShiftRight: K.RSHIFT,
    AltLeft: K.RALT, AltRight: K.RALT,
    KeyQ: 'Q'.charCodeAt(0), KeyE: 'E'.charCodeAt(0), KeyF: 'F'.charCodeAt(0),
    KeyY: 'Y'.charCodeAt(0), KeyH: 'H'.charCodeAt(0), KeyJ: K.FIRE,
    KeyM: 'M'.charCodeAt(0), KeyR: 'R'.charCodeAt(0),
    Comma: K.PREVW, Period: K.NEXTW,
    Digit1: '1'.charCodeAt(0), Digit2: '2'.charCodeAt(0), Digit3: '3'.charCodeAt(0),
    Digit4: '4'.charCodeAt(0), Digit5: '5'.charCodeAt(0), Digit6: '6'.charCodeAt(0),
    Digit7: '7'.charCodeAt(0),
    F1: K.F1, F2: K.F2, F3: K.F3, F4: K.F4, F5: K.F5, F6: K.F6, F7: K.F7, F8: K.F8
  };

  const PREVENT = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab']);
  const held = new Map();   /* "source:doomcode" -> true, for real transitions */

  /* Transitions only: the browser repeats keydown while a key is held, and the
   * menu cursor would scroll off on every repeat. Sources are tracked apart so
   * that letting go of the mouse cannot release a fire button that Ctrl is
   * still holding. */
  function push(pressed, code, source)
  {
    if (!code) return;
    const id = (source || 'kbd') + ':' + code;

    if (pressed)
    {
      if (held.has(id)) return;
      held.set(id, true);
    }
    else
    {
      if (!held.has(id)) return;
      held.delete(id);
    }
    if (typeof Module !== 'undefined' && Module._dg_push_key)
      Module.ccall('dg_push_key', null, ['number', 'number'], [pressed ? 1 : 0, code]);
  }

  /* Losing focus used to leave the engine believing a key was still down, so
   * the player walked into a wall forever after an alt-tab. */
  function releaseAll()
  {
    for (const id of Array.from(held.keys()))
    {
      const code = parseInt(id.split(':')[1], 10);
      held.delete(id);
      if (typeof Module !== 'undefined' && Module._dg_push_key)
        Module.ccall('dg_push_key', null, ['number', 'number'], [0, code]);
    }
  }

  function reset() { releaseAll(); }

  function bindKeys(target) {
    target.addEventListener('keydown', (e) => {
      const code = MAP[e.code];
      if (code === undefined) return;
      if (PREVENT.has(e.code)) e.preventDefault();
      push(true, code);
    });
    target.addEventListener('keyup', (e) => {
      const code = MAP[e.code];
      if (code === undefined) return;
      if (PREVENT.has(e.code)) e.preventDefault();
      push(false, code);
    });
    target.addEventListener('blur', reset);
  }

  // A browser port has to answer to the mouse as well. Vanilla DOOM's mouse
  // buttons are fire / use / strafe, and the engine already models them as
  // keys, so the buttons land on the same keycodes the keyboard uses.
  const MOUSE_BUTTON = { 0: K.FIRE, 1: K.USE, 2: K.RALT };

  function bindMouse(canvas)
  {
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const code = MOUSE_BUTTON[e.button];
      if (code !== undefined) push(true, code, 'mouse');
    });
    // release on the window: the button can come up outside the canvas
    window.addEventListener('mouseup', (e) => {
      const code = MOUSE_BUTTON[e.button];
      if (code !== undefined) push(false, code, 'mouse');
    });
    window.addEventListener('blur', releaseAll);
  }

  // Gamepad: analog axes become held-key transitions, because Doom's input
  // layer only understands keys being up or down.
  const PAD = {
    0: K.FIRE, 1: K.USE, 2: K.ESC, 3: K.RSHIFT,
    4: K.PREVW, 5: K.NEXTW, 6: K.RALT, 7: K.FIRE,
    8: K.TAB, 9: K.ESC, 10: K.RALT,
    12: K.UP, 13: K.DOWN, 14: K.LEFT, 15: K.RIGHT
  };
  const padHeld = new Map();
  const DEAD = 0.35;

  function pollPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    for (const p of pads) if (p && p.connected) { pad = p; break; }
    if (!pad) return false;

    const want = new Set();
    for (let i = 0; i < pad.buttons.length; i++) {
      if (pad.buttons[i].pressed && PAD[i] !== undefined) want.add(PAD[i]);
    }
    const lx = pad.axes[0] || 0, ly = pad.axes[1] || 0, rx = pad.axes[2] || 0;
    if (ly < -DEAD) want.add(K.UP); else if (ly > DEAD) want.add(K.DOWN);
    if (lx < -DEAD) want.add(K.LEFT); else if (lx > DEAD) want.add(K.RIGHT);
    if (rx < -DEAD) want.add(K.STRAFE_L); else if (rx > DEAD) want.add(K.STRAFE_R);

    for (const k of want) if (!padHeld.has(k)) { padHeld.set(k, true); push(true, k, 'pad'); }
    for (const k of Array.from(padHeld.keys())) if (!want.has(k)) { padHeld.delete(k); push(false, k, 'pad'); }
    return true;
  }

  return { bindKeys, bindMouse, pollPad, K, reset };
})();
