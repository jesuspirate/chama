// The later digital illustration has its own finite, user-controlled timeline.
(() => {
  const demo = document.querySelector('.claim-demo');
  const action = demo.querySelector('.claim-action');
  let elapsed = 0, running = false, frame = 0, last = 0, visible = false, explicit = false;
  function labels() {
    const state = elapsed >= 3 ? 'locked' : elapsed >= 1.8 ? 'locking' : 'ready';
    demo.dataset.state = state;
    demo.querySelector('.claim-status').textContent = word(state === 'locked' ? 'claimReceived' : state === 'locking' ? 'claimPending' : 'claimReady');
    demo.querySelector('.claim-detail').textContent = word(state === 'locked' ? 'claimDone' : 'claimUnlocked');
    action.textContent = word(state === 'locked' ? 'replayFilm' : state === 'locking' ? 'claimPending' : 'claimCollect');
    action.disabled = state === 'locking';
  }
  function pause() { running = false; cancelAnimationFrame(frame); }
  function tick(now) {
    if (!running) return;
    elapsed = Math.min(4, elapsed + Math.min((now - last) / 1000, .1)); last = now;
    labels();
    if (elapsed < 4) frame = requestAnimationFrame(tick); else pause();
  }
  function sync() {
    if (!visible || document.hidden || elapsed >= 4 || (!explicit && !autoAllowed())) { pause(); return; }
    if (!running) { running = true; last = performance.now(); frame = requestAnimationFrame(tick); }
  }
  action.addEventListener('click', () => {
    elapsed = elapsed >= 3 ? 0 : 1.8; explicit = true;
    if (reducedMotion.matches) { elapsed = 4; pause(); } else sync();
    labels();
  });
  new IntersectionObserver(entries => { visible = entries[0].isIntersecting; sync(); }, { threshold: .5 }).observe(demo);
  document.addEventListener('visibilitychange', sync);
  document.addEventListener('chama-language', labels);
  reducedMotion.addEventListener('change', () => { explicit = false; sync(); });
  mobile.addEventListener('change', () => { explicit = false; sync(); });
  connection?.addEventListener('change', sync);
  labels();
})();
