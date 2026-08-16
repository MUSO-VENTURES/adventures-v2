/*
 * MUSO Adventures — Adventure Coin flip widget.
 * Self-contained: include this one script tag anywhere in the app and call
 * window.MusoCoinFlip.flip() to pop an animated heads/tails coin flip.
 * Reads the app's existing theme via CSS custom properties (--coral, --ink,
 * --card, --card-bg, --shadow-rgb, --ease-bounce, Fredoka/Nunito) so it
 * matches whatever page it's dropped into, light or dark.
 *
 * Face art resolves relative to THIS script's own URL (coin/heads.png,
 * coin/tails.png next to it), so the same <script src> works no matter how
 * deep the including page lives (preview/, shop/, admin/, ...).
 */
(function () {
  if (window.MusoCoinFlip) return;

  var scriptEl = document.currentScript;
  function resolve(rel) {
    return new URL(rel, scriptEl ? scriptEl.src : document.baseURI).href;
  }

  // Math.random() is fine statistically, but every flip landing on the same
  // spin count/duration/arc makes the motion itself feel scripted even
  // though the face is fair — see randomizeFlight() below. This pulls from
  // the OS CSPRNG when available (true entropy, not a seedable PRNG) so
  // the coin/spin/duration/wobble pick is as unpredictable as the result.
  function random01() {
    if (window.crypto && window.crypto.getRandomValues) {
      var buf = new Uint32Array(1);
      window.crypto.getRandomValues(buf);
      return buf[0] / 4294967296;
    }
    return Math.random();
  }
  function randomBetween(min, max) {
    return min + random01() * (max - min);
  }
  var HEADS_SRC = resolve('coin/heads.png');
  var TAILS_SRC = resolve('coin/tails.png');

  var STYLE_ID = 'muso-coinflip-styles';
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '.mca-overlay{position:fixed; inset:0; z-index:2200; background:rgba(var(--shadow-rgb,42,36,56),0.85);',
      '  display:flex; align-items:center; justify-content:center; padding:6vw;',
      '  opacity:0; transition:opacity .22s ease;}',
      '.mca-overlay.mca-in{opacity:1;}',
      '.mca-card{background:var(--card,#fff); color:var(--ink,#2a2438); border-radius:24px; max-width:380px; width:100%;',
      '  padding:30px 26px 26px; text-align:center; position:relative; box-shadow:0 20px 60px rgba(0,0,0,0.35);',
      '  font-family:"Nunito",sans-serif; transform:scale(0.85) translateY(10px); transition:transform .3s var(--ease-bounce,cubic-bezier(0.34,1.56,0.64,1));}',
      '.mca-overlay.mca-in .mca-card{transform:scale(1) translateY(0);}',
      '.mca-close{position:absolute; top:12px; right:12px; background:rgba(var(--shadow-rgb,42,36,56),0.08); border:none;',
      '  width:30px; height:30px; border-radius:50%; font-size:1.2rem; line-height:1; cursor:pointer; color:var(--ink,#2a2438);}',
      '.mca-eyebrow{color:var(--tangerine,#f2994a); font-weight:700; letter-spacing:0.06em; text-transform:uppercase;',
      '  font-size:0.72rem; margin-bottom:6px;}',
      '.mca-heading{font-family:"Fredoka",sans-serif; font-size:1.25rem; font-weight:700; margin:0 0 20px;}',
      '.mca-names-row{display:flex; align-items:center; justify-content:center; gap:14px; margin-bottom:4px;}',
      '.mca-name{font-family:"Fredoka",sans-serif; font-weight:700; font-size:0.95rem; color:var(--ink,#2a2438);',
      '  opacity:0.55; transition:opacity .3s, transform .3s; transform:scale(1); max-width:34%;',
      '  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}',
      '.mca-name.mca-name-winner{opacity:1; color:var(--coral,#e8503f);',
      '  animation:mcaNameWin .5s var(--ease-bounce,cubic-bezier(0.34,1.56,0.64,1)) forwards;}',
      '.mca-name.mca-name-loser{opacity:0.4; transform:scale(0.88);}',
      '@keyframes mcaNameWin{0%{transform:scale(1);} 55%{transform:scale(1.35);} 100%{transform:scale(1.18);}}',
      '.mca-stage{position:relative; width:190px; height:190px; margin:0 auto 8px; perspective:900px;}',
      '.mca-shadow{position:absolute; left:50%; bottom:2px; width:130px; height:22px; margin-left:-65px;',
      '  background:radial-gradient(ellipse at center, rgba(0,0,0,0.35), rgba(0,0,0,0) 70%); border-radius:50%;',
      '  animation:mcaShadowIdle 2.6s ease-in-out infinite;}',
      '.mca-coin{position:absolute; inset:0; margin:auto; width:170px; height:170px; transform-style:preserve-3d;',
      '  transform:rotateX(0deg); animation:mcaIdleBob 2.6s ease-in-out infinite;}',
      '.mca-face{position:absolute; inset:0; border-radius:50%; backface-visibility:hidden; overflow:hidden;',
      '  box-shadow:0 6px 22px rgba(0,0,0,0.3);}',
      '.mca-face img{width:100%; height:100%; object-fit:contain; display:block;}',
      '.mca-face-tails{transform:rotateX(180deg);}',
      // Duration comes from --mca-duration, set fresh per flip in JS —
      // the 1.85s here is only the fallback for the custom property.
      '.mca-coin.mca-flipping{animation-name:mcaFlip; animation-duration:var(--mca-duration,1.85s); animation-timing-function:cubic-bezier(0.45,0,0.2,1); animation-fill-mode:forwards;}',
      '.mca-shadow.mca-flipping{animation-name:mcaShadowFlip; animation-duration:var(--mca-duration,1.85s); animation-timing-function:cubic-bezier(0.45,0,0.2,1); animation-fill-mode:forwards;}',
      '.mca-coin.mca-landed{animation:mcaLandBounce .4s ease-out;}',
      '@keyframes mcaIdleBob{0%,100%{transform:translateY(0) rotateX(0deg);} 50%{transform:translateY(-6px) rotateX(0deg);}}',
      '@keyframes mcaShadowIdle{0%,100%{transform:scale(1); opacity:0.8;} 50%{transform:scale(0.85); opacity:0.55;}}',
      // rotateX tumbles the coin end-over-end (like a real toss); rotateZ
      // adds a slight side-to-side wobble/precession on top, not the main
      // spin axis — swapping this for rotateY would spin it flat like a
      // top instead of tumbling through the air.
      // --mca-toss-height and --mca-wobble are randomized per flip so the
      // arc height and side-to-side roll aren't identical every time —
      // only the rotateX progress toward --mca-final-rot has to land
      // exactly on target; everything else can (and should) vary.
      '@keyframes mcaFlip{',
      '  0%{transform:translateY(0) rotateX(0deg) rotateZ(0deg) scaleY(1);}',
      '  8%{transform:translateY(calc(-20% * var(--mca-toss-height,1))) rotateX(calc(var(--mca-final-rot) * 0.12)) rotateZ(calc(-3deg * var(--mca-wobble,1))) scaleY(1.02);}',
      '  24%{transform:translateY(calc(-52% * var(--mca-toss-height,1))) rotateX(calc(var(--mca-final-rot) * 0.32)) rotateZ(calc(3deg * var(--mca-wobble,1))) scaleY(1);}',
      '  45%{transform:translateY(calc(-64% * var(--mca-toss-height,1))) rotateX(calc(var(--mca-final-rot) * 0.55)) rotateZ(calc(-2deg * var(--mca-wobble,1))) scaleY(0.98);}',
      '  68%{transform:translateY(calc(-34% * var(--mca-toss-height,1))) rotateX(calc(var(--mca-final-rot) * 0.78)) rotateZ(calc(2deg * var(--mca-wobble,1))) scaleY(1);}',
      '  86%{transform:translateY(calc(-4% * var(--mca-toss-height,1))) rotateX(calc(var(--mca-final-rot) * 0.96)) rotateZ(0deg) scaleY(1.04);}',
      '  92%{transform:translateY(2%) rotateX(var(--mca-final-rot)) rotateZ(0deg) scaleY(0.8);}',
      '  100%{transform:translateY(0) rotateX(var(--mca-final-rot)) rotateZ(0deg) scaleY(1);}',
      '}',
      '@keyframes mcaShadowFlip{',
      '  0%{transform:scale(1); opacity:0.8;}',
      '  45%{transform:scale(0.55); opacity:0.35;}',
      '  92%{transform:scale(1.15); opacity:0.85;}',
      '  100%{transform:scale(1); opacity:0.8;}',
      '}',
      // Must restate rotateX(var(--mca-rest-rot)) at every stop, not just
      // scaleY — an animated transform list fully replaces the property
      // for its duration, so omitting the rotation here would snap the
      // coin back to face-up (0deg) for this whole bounce, independent of
      // whatever face actually landed.
      '@keyframes mcaLandBounce{',
      '  0%{transform:rotateX(var(--mca-rest-rot,0deg)) scaleY(0.85);}',
      '  55%{transform:rotateX(var(--mca-rest-rot,0deg)) scaleY(1.05);}',
      '  100%{transform:rotateX(var(--mca-rest-rot,0deg)) scaleY(1);}',
      '}',
      // opacity:0 here (not the `hidden` attribute, which the old markup
      // used) is what keeps this space reserved before a result lands —
      // `hidden` maps to display:none in the UA stylesheet, which drops
      // min-height entirely and made the whole card visibly grow the
      // instant a result appeared. Opacity keeps the box in layout the
      // entire time; only its color classes below make it visible.
      '.mca-result{font-family:"Fredoka",sans-serif; font-weight:700; font-size:1.5rem; margin:14px 0 4px; min-height:1.9rem; opacity:0;}',
      '.mca-result-heads{color:var(--coral,#e8503f); opacity:1; animation:mcaResultPop .35s var(--ease-bounce,cubic-bezier(0.34,1.56,0.64,1)) both;}',
      '.mca-result-tails{color:var(--deep-teal,#0b6e68); opacity:1; animation:mcaResultPop .35s var(--ease-bounce,cubic-bezier(0.34,1.56,0.64,1)) both;}',
      '@keyframes mcaResultPop{from{opacity:0; transform:scale(0.6) translateY(8px);} to{opacity:1; transform:scale(1) translateY(0);}}',
      '.mca-actions{display:flex; gap:10px; margin-top:18px;}',
      '.mca-btn{flex:1; border:none; padding:12px 18px; border-radius:999px; font-weight:700;',
      '  font-family:"Fredoka",sans-serif; cursor:pointer; font-size:0.92rem; transition:transform .15s, opacity .15s;}',
      '.mca-btn:active{transform:scale(0.96);}',
      '.mca-btn:disabled{opacity:0.55; cursor:default; transform:none;}',
      '.mca-btn-primary{background:var(--coral,#e8503f); color:#fff;}',
      '.mca-btn-secondary{background:rgba(var(--shadow-rgb,42,36,56),0.08); color:var(--ink,#2a2438);}'
    ].join('\n');
    document.head.appendChild(style);
  }

  // Short synthesized whoosh (rising) and landing tink — no audio asset
  // needed, and it no-ops quietly if WebAudio is unavailable/blocked.
  function playFlipSound() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(220, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.9);
      gain.gain.setValueAtTime(0.06, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.0);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 1.0);
      osc.onended = function () { ctx.close(); };
    } catch (e) { /* audio not available — silent flip is fine */ }
  }
  function playLandSound() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx();
      [1200, 1800].forEach(function (freq, i) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        gain.gain.setValueAtTime(0.08, ctx.currentTime + i * 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + i * 0.02);
        osc.stop(ctx.currentTime + 0.4);
      });
      setTimeout(function () { ctx.close(); }, 500);
      if (navigator.vibrate) navigator.vibrate(18);
    } catch (e) { /* audio not available — silent landing is fine */ }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * Opens the coin-flip overlay. Returns a Promise that resolves with
   * 'heads' | 'tails' once the player has flipped and dismissed the
   * result, or null if they close the overlay without flipping.
   *
   * options:
   *   prompt        heading text, e.g. "Who orders first?"
   *   title         small eyebrow label above the heading
   *   headsLabel    text shown on a heads result (default "HEADS!")
   *   tailsLabel    text shown on a tails result (default "TAILS!")
   *   headsName     player name bookending the left/heads side of the coin
   *                 (omit both headsName/tailsName for the plain solo look)
   *   tailsName     player name bookending the right/tails side of the coin
   *   result        force 'heads' | 'tails' (mainly for testing)
   *   sound         false to mute the synthesized whoosh/tink
   *   closeOnResult auto-close ~1.4s after landing instead of waiting on Done
   *   beforeFlip()  optional, called when the flip button is pressed, before
   *                 the animation starts. May return a Promise. Returning/
   *                 resolving false cancels the flip without animating (the
   *                 caller is expected to show its own message — a paywall,
   *                 an error — instead); anything else lets the flip proceed.
   *                 This is the only hook a caller needs to gate flips
   *                 behind a budget/purchase without this widget knowing
   *                 anything about coins, XP, or a backend.
   *   onResult(face) called the instant the coin lands, before close
   */
  function flip(options) {
    var opts = options || {};
    injectStyles();

    return new Promise(function (resolvePromise) {
      var showNames = !!(opts.headsName || opts.tailsName);
      var overlay = document.createElement('div');
      overlay.className = 'mca-overlay';
      overlay.innerHTML =
        '<div class="mca-card" role="dialog" aria-modal="true" aria-label="Adventure Coin flip">' +
        '  <button type="button" class="mca-close" aria-label="Close">&times;</button>' +
        '  <div class="mca-eyebrow">' + (opts.title || 'Adventure Coin') + '</div>' +
        '  <h3 class="mca-heading">' + (opts.prompt || 'Flip to decide') + '</h3>' +
        (showNames
          ? '  <div class="mca-names-row">' +
            '    <div class="mca-name mca-name-heads">' + escapeHtml(opts.headsName || 'Heads') + '</div>' +
            '    <div class="mca-name mca-name-tails">' + escapeHtml(opts.tailsName || 'Tails') + '</div>' +
            '  </div>'
          : '') +
        '  <div class="mca-stage">' +
        '    <div class="mca-shadow"></div>' +
        '    <div class="mca-coin">' +
        '      <div class="mca-face mca-face-heads"><img src="' + HEADS_SRC + '" alt="Heads"></div>' +
        '      <div class="mca-face mca-face-tails"><img src="' + TAILS_SRC + '" alt="Tails"></div>' +
        '    </div>' +
        '  </div>' +
        '  <div class="mca-result"></div>' +
        '  <div class="mca-actions">' +
        '    <button type="button" class="mca-btn mca-btn-primary mca-flip-btn">🪙 Flip the Coin</button>' +
        '  </div>' +
        '</div>';
      document.body.appendChild(overlay);
      requestAnimationFrame(function () { overlay.classList.add('mca-in'); });

      var coin = overlay.querySelector('.mca-coin');
      var shadow = overlay.querySelector('.mca-shadow');
      var stage = overlay.querySelector('.mca-stage'); // common ancestor of coin+shadow — one custom-property write here, both inherit it
      var resultEl = overlay.querySelector('.mca-result');
      var headsNameEl = overlay.querySelector('.mca-name-heads');
      var tailsNameEl = overlay.querySelector('.mca-name-tails');
      var flipBtn = overlay.querySelector('.mca-flip-btn');
      var closeBtn = overlay.querySelector('.mca-close');
      var settled = false;
      var outcome = null;
      var landTimer = null;

      function close(resolveWith) {
        overlay.classList.remove('mca-in');
        setTimeout(function () { overlay.remove(); }, 220);
        resolvePromise(resolveWith);
      }

      closeBtn.addEventListener('click', function () { close(settled ? outcome : null); });
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) close(settled ? outcome : null);
      });

      async function doFlip() {
        if (flipBtn.disabled) return;
        flipBtn.disabled = true;

        if (typeof opts.beforeFlip === 'function') {
          var allowed = await opts.beforeFlip();
          if (allowed === false) { flipBtn.disabled = false; return; } // caller already showed its own message
        }

        resultEl.textContent = '';
        resultEl.className = 'mca-result'; // strips the winner color class, back to reserved-but-invisible
        settled = false;
        coin.classList.remove('mca-landed');
        coin.style.animation = 'none';
        shadow.style.animation = 'none';
        // A repeat flip must also clear the inline transform the previous
        // landing set below — left in place, that stale rotateX(...) base
        // value corrupts the next mcaFlip run into rendering as identity.
        coin.style.transform = '';
        if (headsNameEl) headsNameEl.className = 'mca-name mca-name-heads';
        if (tailsNameEl) tailsNameEl.className = 'mca-name mca-name-tails';
        void coin.offsetWidth; // restart animation from a clean state on repeat flips

        var forced = (opts.result === 'heads' || opts.result === 'tails') ? opts.result : (random01() < 0.5 ? 'heads' : 'tails');

        // Every one of these is redrawn from the CSPRNG per flip, wide
        // enough that no two flips move alike even when they land the
        // same face — extraSpins alone has 12 possible values (5-16), and
        // it's compounded with toss height, wobble, and duration.
        var extraSpins = 5 + Math.floor(random01() * 12); // 5-16 full extra spins before landing
        var totalHalfTurns = extraSpins * 2 + (forced === 'tails' ? 1 : 0);
        coin.style.setProperty('--mca-final-rot', (totalHalfTurns * 180) + 'deg');
        coin.style.setProperty('--mca-toss-height', randomBetween(0.8, 1.22).toFixed(3));
        coin.style.setProperty('--mca-wobble', randomBetween(0.55, 1.55).toFixed(3));

        var durationMs = Math.round(randomBetween(1450, 2250));
        stage.style.setProperty('--mca-duration', durationMs + 'ms');

        if (opts.sound !== false) playFlipSound();

        coin.style.animation = '';
        shadow.style.animation = '';
        coin.classList.add('mca-flipping');
        shadow.classList.add('mca-flipping');

        clearTimeout(landTimer);
        landTimer = setTimeout(function () {
          coin.classList.remove('mca-flipping');
          shadow.classList.remove('mca-flipping');
          var restDeg = forced === 'tails' ? 180 : 0;
          coin.style.setProperty('--mca-rest-rot', restDeg + 'deg');
          coin.style.transform = 'rotateX(' + restDeg + 'deg)';
          coin.classList.add('mca-landed');
          if (opts.sound !== false) playLandSound();

          resultEl.textContent = forced === 'heads' ? (opts.headsLabel || 'HEADS!') : (opts.tailsLabel || 'TAILS!');
          resultEl.className = 'mca-result mca-result-' + forced;

          if (headsNameEl && tailsNameEl) {
            var winnerEl = forced === 'heads' ? headsNameEl : tailsNameEl;
            var loserEl = forced === 'heads' ? tailsNameEl : headsNameEl;
            winnerEl.classList.add('mca-name-winner');
            loserEl.classList.add('mca-name-loser');
          }

          flipBtn.disabled = false;
          flipBtn.textContent = '🔄 Flip Again';
          settled = true;
          outcome = forced;

          if (typeof opts.onResult === 'function') opts.onResult(forced);
          if (opts.closeOnResult) setTimeout(function () { close(outcome); }, 1400);
        }, durationMs);
      }

      flipBtn.addEventListener('click', doFlip);
    });
  }

  window.MusoCoinFlip = { flip: flip };
})();
