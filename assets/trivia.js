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

  // Category is either auto-picked server-side from the adventure's own
  // theme (_shared/triviaGenerator.ts's VENUE_THEME_TO_CATEGORY) or chosen
  // directly by the player (the category picker — see preview/index.html's
  // renderTriviaCategoryPicker/chooseTriviaCategory), so this badge is what
  // tells them which one they're playing either way.
  var CATEGORY_LABELS = {
    dogs: '🐕 Underdogs',
    great_outdoors: '🏞️ Great Outdoors',
    curiosities: '🔮 Curiosities',
    food_for_thought: '🍽️ Food for Thought',
    after_hours: '🌙 After Hours',
    wtf: '🤯 WTF?!',
  };
  var DIFFICULTY_LABELS = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

  // Games are a fixed 5 questions (QUESTIONS_PER_GAME in _shared/
  // triviaGenerator.ts) — mirrored here as a plain constant rather than
  // threaded through as a prop, since this renderer only needs it for the
  // "Question X of 5" label, not for any actual game-boundary logic (the
  // server is the one deciding when a game ends, via round.gameCorrectCount
  // being non-null on the 5th round).
  var QUESTIONS_PER_GAME = 5;

  function renderCategoryBadge(round) {
    var catLabel = CATEGORY_LABELS[round.category] || round.category;
    var diffLabel = DIFFICULTY_LABELS[round.difficulty] || round.difficulty;
    var progressLabel = round.questionInGame ? 'Q' + round.questionInGame + '/' + QUESTIONS_PER_GAME : '';
    if (!catLabel && !diffLabel && !progressLabel) return '';
    return (
      '<div class="trivia-category-badge">' +
      (catLabel ? '<span class="trivia-category-pill">' + escapeHtml(catLabel) + '</span>' : '') +
      (diffLabel ? '<span class="trivia-difficulty-pill trivia-difficulty-' + escapeHtml(round.difficulty || '') + '">' + escapeHtml(diffLabel) + '</span>' : '') +
      (progressLabel ? '<span class="trivia-category-pill">' + escapeHtml(progressLabel) + '</span>' : '') +
      '</div>'
    );
  }

  // Shown only on the 5th question of a game, once it resolves/expires
  // (round.gameCorrectCount is set — see trivia/index.ts's
  // maybeCompleteGame). Every party member sees the same summary, since
  // it's written onto the round row itself and fanned out via realtime,
  // not just returned to whoever answered last — including the full
  // question-by-question recap (round.gameSummary) and an explicit
  // advanced/didn't-advance message, not just the bare score.
  function renderGameOverBanner(round, myProfileId, resolveName) {
    var correct = round.gameCorrectCount;
    if (correct == null) return '';

    var line = '🏁 Game over: ' + correct + '/' + QUESTIONS_PER_GAME + ' correct';

    var recapRows = (round.gameSummary || [])
      .map(function (item, i) {
        var mark = item.correct ? '✅' : '❌';
        var who = '';
        if (item.correct && round.mode === 'group' && item.winnerProfileId) {
          who = ' (' + (item.winnerProfileId === myProfileId ? 'you' : escapeHtml(resolveName(item.winnerProfileId))) + ')';
        }
        return '<div class="trivia-recap-row">' + (i + 1) + '. ' + mark + ' ' + escapeHtml(item.questionText) + who + '</div>';
      })
      .join('');
    var recap = recapRows ? '<div class="trivia-recap-list">' + recapRows + '</div>' : '';

    // Explicit advanced-or-not messaging, not just a score — a perfect
    // game that's already at the Hard ceiling still reads as a win, it
    // just has nowhere higher to advance to.
    var message;
    if (round.gameLeveledUp) {
      message = '<div class="trivia-levelup-banner">🎉 Congrats! You advanced to ' + escapeHtml(DIFFICULTY_LABELS[round.gameNewDifficulty] || round.gameNewDifficulty) + '!</div>';
    } else if (correct === QUESTIONS_PER_GAME) {
      message = '<div class="trivia-levelup-banner">🏆 Perfect round! You\'re already at the top difficulty.</div>';
    } else {
      message = '<div class="trivia-nextround-banner">🍀 Good luck next round! Get a perfect 5/5 to level up.</div>';
    }

    return '<div class="trivia-gameover-line">' + line + '</div>' + recap + message;
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
    const onSuggestAdventureRef = callbacks.onSuggestAdventureRef;

    if (!round) {
      container.innerHTML = '<div class="trivia-empty">Getting your question ready…</div>';
      return;
    }

    const isMine = round.activeTurnProfileId === myProfileId;
    const iHaveBuzzed = buzzes.some((b) => b.profileId === myProfileId);
    const iAmTried = (round.triedProfileIds || []).includes(myProfileId);

    let body = renderCategoryBadge(round);
    body += `<div class="trivia-question">${escapeHtml(round.questionText)}</div>`;

    if (round.status === 'resolved' || round.status === 'expired') {
      body += renderReveal(round, myProfileId, resolveName);
      var isGameOver = round.gameCorrectCount != null;
      body += renderGameOverBanner(round, myProfileId, resolveName);
      // Only on the game-over "win card" (not every single question), and
      // only when there's no adventure already going — nudges toward the
      // real-venue theme matching whatever category was just played.
      if (isGameOver && !state.midAdventure && onSuggestAdventureRef) {
        var themeCatLabel = (CATEGORY_LABELS[round.category] || round.category).replace(/^\S+\s*/, '');
        body += `<button type="button" class="pb-btn secondary trivia-suggest-adventure-btn" onclick="${onSuggestAdventureRef}('${round.category}')">🎯 Start a ${escapeHtml(themeCatLabel)} Adventure</button>`;
      }
      body += `<button type="button" class="pb-btn primary trivia-next-btn" onclick="${onNextRef}()">${isGameOver ? '▶ Play Next Game' : '▶ Next Question'}</button>`;
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

  window.MusoTrivia = { render: render, CATEGORY_LABELS: CATEGORY_LABELS };
})();
