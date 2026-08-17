/*
 * MUSO Adventures — Trivia Break renderer.
 *
 * Unlike coin-flip.js (a fully self-contained widget with zero backend),
 * this is a PURE RENDERER only: given a snapshot of { round, buzzes,
 * myProfileId, resolveName } plus a few global callback function names, it
 * turns that state into the right screen (waiting-for-buzz / your-turn /
 * spectating / reveal) and wires buttons to call those globals. It owns no
 * network calls and no realtime subscription of its own — Trivia's state
 * machine (postEdgeFunction calls, the ensurePartyRealtime channel, answer
 * timers) is inherently tied to app internals only preview/index.html has,
 * so re-abstracting all of that behind callbacks here would just add
 * indirection with no reuse payoff (this widget isn't meant to drop
 * unmodified into shop/ or admin/ the way coin-flip.js is).
 *
 * Reads the app's existing theme via CSS custom properties (--coral,
 * --deep-teal, --ink, --shadow-rgb, --ease-bounce, Fredoka/Nunito) — no
 * styles are injected here, they live in preview/index.html's own <style>
 * block next to the rest of the minigame CSS.
 */
(function () {
  if (window.MusoTrivia) return;

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderBuzzOrder(buzzes, resolveName, triedProfileIds) {
    if (!buzzes || !buzzes.length) return '';
    const tried = new Set(triedProfileIds || []);
    const rows = buzzes
      .map((b, i) => {
        const mark = tried.has(b.profileId) ? '❌' : '⏳';
        return `<div>${i + 1}. ${mark} ${escapeHtml(resolveName(b.profileId))}</div>`;
      })
      .join('');
    return `<div class="trivia-buzz-order">${rows}</div>`;
  }

  function renderChoices(round, enabled, onAnswerRef) {
    const choices = round.choices || [];
    const btns = choices
      .map((c) => {
        const disabledAttr = enabled ? '' : 'disabled';
        return `<button type="button" class="trivia-choice-btn" ${disabledAttr} onclick="${onAnswerRef}('${c.key}')">${escapeHtml(c.text)}</button>`;
      })
      .join('');
    return `<div class="trivia-choices">${btns}</div>`;
  }

  function renderBuzzer(disabled, onBuzzRef) {
    return `<button type="button" class="trivia-buzzer-btn" ${disabled ? 'disabled' : ''} onclick="${onBuzzRef}()">${disabled ? 'Buzzed!' : 'BUZZ IN'}</button>`;
  }

  function renderReveal(round, myProfileId, resolveName) {
    const choices = round.choices || [];
    const rows = choices
      .map((c) => {
        let cls = 'trivia-choice-btn';
        if (c.key === round.correctChoiceKey) cls += ' correct';
        return `<button type="button" class="${cls}" disabled>${escapeHtml(c.text)}</button>`;
      })
      .join('');

    let outcomeLine;
    if (round.mode === 'solo') {
      outcomeLine = round.winnerProfileId
        ? `✅ Correct! +${round.xpAwarded || 0} XP`
        : `The answer was <strong>${escapeHtml((choices.find((c) => c.key === round.correctChoiceKey) || {}).text || '')}</strong>.`;
    } else if (round.winnerProfileId) {
      const who = round.winnerProfileId === myProfileId ? 'You' : escapeHtml(resolveName(round.winnerProfileId));
      outcomeLine = `🏆 ${who} got it! ${round.winnerProfileId === myProfileId ? `+${round.xpAwarded || 0} XP` : ''}`;
    } else {
      outcomeLine = `Nobody got it. The answer was <strong>${escapeHtml((choices.find((c) => c.key === round.correctChoiceKey) || {}).text || '')}</strong>.`;
    }

    const explanation = round.explanation ? `<p class="trivia-explanation">${escapeHtml(round.explanation)}</p>` : '';
    return `<div class="trivia-choices">${rows}</div><p class="trivia-outcome">${outcomeLine}</p>${explanation}`;
  }

  function render(container, state, callbacks) {
    const round = state.round;
    const buzzes = state.buzzes || [];
    const myProfileId = state.myProfileId;
    const resolveName = state.resolveName || function () { return 'Someone'; };
    const onBuzzRef = callbacks.onBuzzRef;
    const onAnswerRef = callbacks.onAnswerRef;
    const onNextRef = callbacks.onNextRef;

    if (!round) {
      container.innerHTML = '<div class="trivia-empty">Getting your question ready…</div>';
      return;
    }

    const isMine = round.activeTurnProfileId === myProfileId;
    const iHaveBuzzed = buzzes.some((b) => b.profileId === myProfileId);
    const iAmTried = (round.triedProfileIds || []).includes(myProfileId);

    let body = `<div class="trivia-question">${escapeHtml(round.questionText)}</div>`;

    if (round.status === 'resolved' || round.status === 'expired') {
      body += renderReveal(round, myProfileId, resolveName);
      body += `<button type="button" class="pb-btn primary trivia-next-btn" onclick="${onNextRef}()">▶ Next Question</button>`;
    } else if (round.mode === 'solo') {
      body += renderChoices(round, isMine && !iAmTried, onAnswerRef);
    } else if (round.status === 'buzzing') {
      body += renderBuzzer(iHaveBuzzed || iAmTried, onBuzzRef);
      body += renderBuzzOrder(buzzes, resolveName, round.triedProfileIds);
    } else {
      // 'answering'
      const banner = isMine
        ? "🔔 You're up!"
        : `🔔 ${escapeHtml(resolveName(round.activeTurnProfileId))} is answering…`;
      body += `<div class="trivia-turn-banner">${banner}</div>`;
      body += renderChoices(round, isMine, onAnswerRef);
      body += renderBuzzOrder(buzzes, resolveName, round.triedProfileIds);
    }

    container.innerHTML = body;
  }

  window.MusoTrivia = { render: render };
})();
