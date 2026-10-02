// An additive layer: the chapter thread, reveals, and two small explanations.
// Native scrolling is never intercepted; without this file the page is complete.
(() => {
  const root = document.documentElement;
  if (!('IntersectionObserver' in window)) return;
  root.classList.add('has-experience');
  const still = () => reducedMotion.matches;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  // Each part of the page makes one entrance. When it comes into view everything
  // in it rises together, headlines line by line; once it has left the screen it
  // is ready to do so again.
  const plan = [
    ['.story-bridge .eyebrow', 'rise', 0], ['.story-bridge h2', 'lines', .05], ['.story-bridge>p:not(.eyebrow)', 'rise', .35], ['.bridge-next', 'rise', .5],
    ['.circle-finale-copy .circle-emblem', 'rise', 0], ['.circle-finale-copy .eyebrow', 'rise', .1], ['.circle-finale h2', 'lines', .15], ['.circle-finale-copy>p:not(.eyebrow)', 'rise', .45], ['.circle-finale .text-link', 'rise', .6],
    ['.name .eyebrow', 'rise', 0], ['.name-meta', 'rise', .5], ['.name-def', 'rise', .6], ['.name-body', 'rise', .7], ['.name-horizon>div', 'rise', .8, .12], ['.ring', 'rise', .2],
    ['.life-heading .eyebrow', 'rise', 0], ['.life-heading h2', 'lines', .05], ['.life-aside', 'rise', .35], ['.life-grid article', 'rise', .1, .14],
    ['.trust>div:first-child .eyebrow', 'rise', 0], ['.trust h2', 'lines', .05], ['.trust-intro', 'rise', .35], ['.trust>div:first-child .text-link', 'rise', .45], ['.keys', 'rise', .2], ['.trust-list details', 'rise', 0, .1], ['.facts li', 'rise', 0, .1],
    ['.invitation .eyebrow', 'rise', 0], ['.invitation h2', 'lines', .05], ['.invitation .wrap>p:not(.eyebrow)', 'rise', .35], ['.invitation .wrap>.button', 'rise', .45, .1],
    ['.community-card', 'rise', 0], ['.foot-top>*', 'rise', 0, .1], ['.foot-base', 'rise', .45]
  ];
  const STAGES = '.story-bridge,.circle-finale,.name,.life-heading,.life-grid,.trust>div:first-child,.keys,.trust-list,.facts,.invitation>.wrap,.community,footer';
  function splitLines(el) {
    if (el.querySelector('.xl')) return;
    el.innerHTML = el.innerHTML.split(/<br\s*\/?>/i)
      .map((line, i) => `<span class="xl" style="--l:${i}"><span class="xl-in">${line}</span></span>`).join('');
  }
  const headlines = [], stages = new Map();
  const stageOf = el => { const place = el.closest(STAGES); if (!stages.has(place)) stages.set(place, { items: [], shown: false, timers: [] }); return stages.get(place); };
  plan.forEach(([selector, kind, delay, step = 0]) => document.querySelectorAll(selector).forEach((el, i) => {
    el.dataset.rv = kind;
    el.style.setProperty('--rv-d', `${delay + i * step}s`);
    if (kind === 'lines') { splitLines(el); headlines.push(el); }
    stageOf(el).items.push({ el, kind, delay: delay + i * step });
  }));
  stageOf(document.querySelector('.name-word')).items.push({ el: document.querySelector('.name-word'), kind: 'word', delay: 0 });
  function enter(stage) {
    stage.shown = true;
    stage.items.forEach(({ el, kind, delay }) => {
      el.classList.add('is-in');
      // Hand hover and focus transforms back to the original styles.
      if (kind === 'rise') stage.timers.push(setTimeout(() => el.removeAttribute('data-rv'), 1400 + delay * 1000));
    });
  }
  function leave(stage) {
    stage.shown = false;
    stage.timers.splice(0).forEach(clearTimeout);
    stage.items.forEach(({ el, kind }) => { el.classList.remove('is-in'); if (kind === 'rise') el.dataset.rv = 'rise'; });
  }
  // Resetting happens out of sight and at once, so the next entrance starts clean.
  function rearm(list) {
    root.classList.add('rv-reset');
    list.forEach(leave);
    void root.offsetHeight;
    root.classList.remove('rv-reset');
  }
  const heroTitle = document.querySelector('.cinema h1');
  splitLines(heroTitle);
  headlines.push(heroTitle);
  requestAnimationFrame(() => requestAnimationFrame(() => heroTitle.classList.add('is-in')));
  document.addEventListener('chama-language', () => headlines.forEach(splitLines));

  // The thread follows the reader; it never moves them.
  const thread = document.querySelector('.thread');
  const stops = [...thread.querySelectorAll('a')].map(link => ({ link, target: document.querySelector(link.getAttribute('href')) }));
  const bar = document.querySelector('.thread-bar');
  const nav = document.querySelector('.nav');
  const navLinks = [...nav.querySelectorAll('nav a')].map(link => ({ link, target: document.querySelector(link.getAttribute('href')) }));
  const bridge = document.querySelector('.story-bridge');
  const copies = [...document.querySelectorAll('.journey-chapter>.chapter-copy')];
  const art = document.querySelector('.journey-sticky .journey-art');
  let current = -1, saying = 0, framed = false, cutting = false;
  function follow() {
    framed = false;
    const h = innerHeight, line = h * .45;
    const gone = [];
    stages.forEach((stage, place) => {
      const box = place.getBoundingClientRect();
      if (!stage.shown && !cutting && box.top < h * .8 && box.bottom > h * .08) enter(stage);
      else if (stage.shown && (box.bottom < -120 || box.top > h + 120)) gone.push(stage);
    });
    if (gone.length) rearm(gone);
    const tops = stops.map(stop => stop.target.getBoundingClientRect().top);
    let index = 0;
    tops.forEach((top, i) => { if (top <= line) index = i; });
    const next = index + 1 < tops.length ? tops[index + 1] : root.scrollHeight - scrollY;
    const within = clamp((line - tops[index]) / Math.max(1, next - tops[index]));
    thread.style.setProperty('--thread', (index + within) / (stops.length - 1));
    bar.style.setProperty('--thread', clamp(scrollY / Math.max(1, root.scrollHeight - h)));
    if (index !== current) {
      current = index;
      stops.forEach(({ link }, i) => {
        link.classList.toggle('is-past', i < index);
        link.classList.remove('is-saying');
        if (i === index) link.setAttribute('aria-current', 'true'); else link.removeAttribute('aria-current');
      });
      clearTimeout(saying);
      if (scrollY > 40) {
        stops[index].link.classList.add('is-saying');
        saying = setTimeout(() => stops[index].link.classList.remove('is-saying'), 1800);
      }
    }
    let chapter = -1;
    navLinks.forEach(({ target }, i) => { if (target.getBoundingClientRect().top <= line) chapter = i; });
    navLinks.forEach(({ link }, i) => { if (i === chapter) link.setAttribute('aria-current', 'true'); else link.removeAttribute('aria-current'); });
    // Read the surface beneath the thread, so it stays legible over film and paper.
    const box = thread.getBoundingClientRect();
    if (box.width) {
      const under = document.elementsFromPoint(box.left + box.width / 2, h / 2).find(el => !thread.contains(el));
      thread.dataset.tone = root.dataset.theme === 'dark' || under?.closest('.cinema-screen,.circle-finale,.invitation') ? 'dark' : 'light';
    }
    const floor = nav.offsetHeight + 96;
    // On phones the copy also waits until it has reached its place above the diagram.
    // On phones the copy sits just under the chapter tabs, so it fades only once it
    // scrolls on past that seat, and it waits to appear until it has reached it.
    const seat = mobile.matches ? nav.offsetHeight + 58 : 0;
    copies.forEach(copy => {
      const top = copy.getBoundingClientRect().top;
      copy.style.setProperty('--copy-fade', still() ? 1 : seat ? clamp((top - seat + 64) / 56) * clamp(1 - (top - seat - 6) / 48) : clamp((top - floor) / 70));
    });
    bridge.style.setProperty('--bridge-line', clamp((h * .82 - bridge.getBoundingClientRect().bottom) / (h * .3) + 1));
    // Point at what the chapter is about: the two cards while matching, the three
    // people once agreed, the money as it crosses, then the sats as they leave escrow.
    if (art) {
      const v = name => parseFloat(art.style.getPropertyValue(name)) || 0;
      const released = v('--seller-received') > .99 && v('--vault-opacity') < .97 && v('--buyer-received') < 1;
      art.classList.toggle('is-meet', v('--meet-opacity') > .6 && v('--match-offset') < .3);
      art.classList.toggle('is-agree', v('--agree-opacity') > .5 && v('--arbiter-opacity') > .9);
      art.classList.toggle('is-pay', v('--cash-opacity') > .1);
      art.classList.toggle('is-release', released);
    }
  }
  function schedule() { if (!framed) { framed = true; requestAnimationFrame(follow); } }
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule);
  addEventListener('load', schedule);
  document.addEventListener('chama-language', schedule);
  new MutationObserver(schedule).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  follow();

  // Moving between chapters is a cut, not a long scroll: the page dips to paper,
  // lands on the chapter, and the chapter makes its entrance.
  const veil = document.querySelector('.cut');
  function cutTo(target, hash) {
    const land = () => {
      const flush = target.matches('.cinema,.circle-finale,.invitation,.journey-chapter');
      root.style.scrollBehavior = 'auto';
      scrollTo(0, Math.max(0, target.getBoundingClientRect().top + scrollY - (flush ? 0 : nav.offsetHeight + 24)));
      root.style.scrollBehavior = '';
      history.replaceState(null, '', hash);
      rearm([...stages.values()].filter(stage => stage.shown));
    };
    if (still()) { land(); follow(); return; }
    cutting = true;
    veil.classList.add('is-on');
    setTimeout(() => { land(); requestAnimationFrame(() => { veil.classList.remove('is-on'); cutting = false; follow(); }); }, 340);
  }
  document.querySelectorAll('.thread a,.nav nav a,.nav .brand,.foot-brand .brand,.foot-base a').forEach(link => link.addEventListener('click', event => {
    const target = document.querySelector(link.getAttribute('href'));
    if (!target || cutting || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    cutTo(target, link.getAttribute('href'));
  }));

  // Shared caption behaviour: fade out, change, fade in; repaint on language change.
  function captioner(el) {
    let key = el.dataset.copy;
    document.addEventListener('chama-language', () => { el.textContent = word(key); });
    return next => {
      if (next === key) return;
      key = next;
      if (still()) { el.textContent = word(key); return; }
      el.classList.add('is-changing');
      setTimeout(() => { el.textContent = word(key); el.classList.remove('is-changing'); }, 260);
    };
  }

  // Any two of the three settle a trade. Chama is not one of the three.
  const keys = document.querySelector('.keys');
  const keyButtons = [...keys.querySelectorAll('.key')];
  const sayKeys = captioner(keys.querySelector('.keys-caption'));
  const order = ['buyer', 'seller', 'arbiter'];
  const pairs = [['buyer', 'seller'], ['buyer', 'arbiter'], ['seller', 'arbiter']];
  const pairCopy = { 'buyer-seller': 'keysBuyerSeller', 'buyer-arbiter': 'keysBuyerArbiter', 'seller-arbiter': 'keysSellerArbiter', one: 'keysOne', none: 'keysNone' };
  let chosen = [], touched = false, keysVisible = false, demo = 0, demoIndex = 0;
  function paintKeys() {
    const pair = chosen.length === 2 ? order.filter(role => chosen.includes(role)).join('-') : chosen.length ? 'one' : 'none';
    keys.dataset.pair = pair;
    keyButtons.forEach(button => button.setAttribute('aria-pressed', String(chosen.includes(button.dataset.key))));
    sayKeys(pairCopy[pair]);
  }
  function syncDemo() {
    clearInterval(demo);
    demo = 0;
    if (touched || !keysVisible || document.hidden) return;
    if (still()) { chosen = [...pairs[0]]; paintKeys(); return; }
    const advance = () => { chosen = [...pairs[demoIndex++ % pairs.length]]; paintKeys(); };
    if (!chosen.length) advance();
    demo = setInterval(advance, 3600);
  }
  keyButtons.forEach(button => button.addEventListener('click', () => {
    if (!touched) { touched = true; chosen = []; keys.querySelector('.keys-caption').setAttribute('aria-live', 'polite'); syncDemo(); }
    const role = button.dataset.key;
    chosen = chosen.includes(role) ? chosen.filter(item => item !== role) : [...chosen, role].slice(-2);
    paintKeys();
  }));
  new IntersectionObserver(entries => { keysVisible = entries[0].isIntersecting; syncDemo(); }, { threshold: .45 }).observe(keys);
  document.addEventListener('visibilitychange', syncDemo);
  reducedMotion.addEventListener('change', syncDemo);

  // The circle. Every round everyone locks, then one collects. If a single
  // seat falls short, nothing is paid out: the round refunds and the circle ends.
  const ring = document.querySelector('.ring');
  const stage = ring.querySelector('.ring-stage');
  const seats = [...ring.querySelectorAll('.ring-seat')];
  const coins = [...ring.querySelectorAll('.ring-coin')];
  const sayRing = captioner(ring.querySelector('.ring-caption'));
  let ringVisible = false, ringRun = 0, circle = 0;
  function lock(i, on) {
    seats[i].classList.toggle('is-on', on);
    stage.style.setProperty('--filled', seats.filter(seat => seat.classList.contains('is-on')).length / seats.length);
  }
  function clearRound() {
    seats.forEach((seat, i) => { seat.classList.remove('is-late', 'is-refunded', 'is-collecting'); coins[i].classList.remove('is-out'); lock(i, false); });
    ring.dataset.step = 'rest';
  }
  function clearCircle() {
    clearRound();
    seats.forEach(seat => seat.classList.remove('has-collected'));
  }
  async function turnRing() {
    const run = ++ringRun;
    const live = () => run === ringRun && ringVisible && !document.hidden && !still();
    const pause = async ms => { await wait(ms); return live(); };
    clearCircle();
    while (live()) {
      // Alternate circles: one falls a seat short in its third round, the next completes.
      const shortRound = circle % 2 ? -1 : 2;
      for (let turn = 0; turn < seats.length; turn++) {
        const late = turn === shortRound ? 3 : -1;
        sayRing(turn ? 'beatGive' : 'ringGather');
        for (let i = 0; i < seats.length; i++) {
          if (i === late) continue;
          if (!await pause(turn ? 240 : 420)) return;
          lock(i, true);
        }
        if (late >= 0) {
          seats[late].classList.add('is-late');
          coins[late].classList.add('is-out');
          sayRing('ringLate');
          if (!await pause(2600)) return;
          ring.dataset.step = 'refund';
          seats.forEach((seat, i) => { if (i !== late) { lock(i, false); seat.classList.add('is-refunded'); } });
          sayRing('ringRefund');
          if (!await pause(3600)) return;
          break;
        }
        if (!await pause(650)) return;
        ring.dataset.step = 'give';
        sayRing('beatGive');
        if (!await pause(1500)) return;
        stage.style.setProperty('--turn', turn);
        seats[turn].classList.add('is-collecting');
        ring.dataset.step = 'collect';
        sayRing('beatReceive');
        if (!await pause(1500)) return;
        seats[turn].classList.add('has-collected');
        clearRound();
        sayRing('beatContinue');
        if (!await pause(1100)) return;
      }
      circle++;
      if (!await pause(700)) return;
      clearCircle();
      if (!await pause(600)) return;
    }
  }
  function syncRing() {
    if (still()) { ringRun++; clearCircle(); seats.forEach((seat, i) => lock(i, true)); sayRing('ringGather'); return; }
    if (ringVisible && !document.hidden) void turnRing();
    else ringRun++;
  }
  new IntersectionObserver(entries => { ringVisible = entries[0].isIntersecting; syncRing(); }, { threshold: .35 }).observe(stage);
  document.addEventListener('visibilitychange', syncRing);
  reducedMotion.addEventListener('change', syncRing);
})();
