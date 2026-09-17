// Restored interactions use the existing artwork and current page geometry.
(() => {
  const cursor = document.querySelector('.chama-cursor');
  const pointer = matchMedia('(pointer: fine) and (hover: hover) and (prefers-reduced-motion: no-preference)');
  let cursorFrame = 0, x = 0, y = 0;
  const hide = () => {
    document.documentElement.classList.remove('custom-pointer');
    cursor.classList.remove('visible', 'active');
    cancelAnimationFrame(cursorFrame); cursorFrame = 0;
  };
  addEventListener('pointermove', event => {
    if (!pointer.matches || event.pointerType !== 'mouse') { hide(); return; }
    x = event.clientX; y = event.clientY;
    cursor.classList.toggle('active', Boolean(event.target.closest('a,button,input,summary')));
    if (!cursorFrame) cursorFrame = requestAnimationFrame(() => {
      cursor.style.transform = `translate3d(${x}px,${y}px,0) translate(-50%,-50%)`;
      cursor.classList.add('visible');
      document.documentElement.classList.add('custom-pointer'); cursorFrame = 0;
    });
  }, {passive:true});
  addEventListener('blur', hide);
  document.addEventListener('mouseleave', hide);
  document.addEventListener('visibilitychange', () => { if (document.hidden) hide(); });
  pointer.addEventListener('change', hide);

  const cards = [...document.querySelectorAll('.life-art')];
  function label(tile) {
    const title = tile.closest('article').querySelector('h3').textContent;
    tile.setAttribute('aria-label', `${word(tile.classList.contains('show-symbol') ? 'showFeaturePhoto' : 'showFeatureIcon')}: ${title}`);
    tile.setAttribute('aria-pressed', String(tile.classList.contains('show-symbol')));
  }
  cards.forEach(tile => {
    tile.addEventListener('click', () => { tile.classList.toggle('show-symbol'); label(tile); });
    tile.addEventListener('pointerenter', event => {
      if (event.pointerType === 'mouse') { tile.classList.add('hover-symbol'); }
    });
    tile.addEventListener('pointerleave', () => tile.classList.remove('hover-symbol'));
    tile.addEventListener('keydown', event => {
      if (event.key === 'Escape') { tile.classList.remove('show-symbol','hover-symbol'); label(tile); }
    });
    label(tile);
  });
  document.addEventListener('chama-language', () => cards.forEach(label));

  const medley = document.querySelector('.community-medley');
  const toggle = document.querySelector('.medley-toggle');
  let medleyPaused = false, medleyVisible = false;
  function syncMedley() {
    medley.classList.toggle('is-moving', medleyVisible && !medleyPaused && !document.hidden && !reducedMotion.matches);
    toggle.hidden = reducedMotion.matches;
    toggle.textContent = word(medleyPaused ? 'resumeImages' : 'pauseImages');
    toggle.setAttribute('aria-pressed', String(medleyPaused));
  }
  toggle.addEventListener('click', () => { medleyPaused = !medleyPaused; syncMedley(); });
  new IntersectionObserver(entries => { medleyVisible = entries[0].isIntersecting; syncMedley(); }).observe(medley);
  reducedMotion.addEventListener('change', syncMedley);
  document.addEventListener('visibilitychange', syncMedley);
  document.addEventListener('chama-language', syncMedley);
  syncMedley();
})();
