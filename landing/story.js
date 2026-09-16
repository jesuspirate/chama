// Native scrolling is never intercepted; every chapter also works without motion.
document.querySelectorAll('[data-copy]').forEach(el => { copy.en[el.dataset.copy] = el.innerHTML; });
const cinema = document.querySelector('.cinema');
const screen = document.querySelector('.cinema-screen');
const poster = document.querySelector('.cinema-poster');
const video = document.querySelector('.hero-video');
const motionButton = document.querySelector('.motion-toggle');
const beat = document.querySelector('.film-beat');
const journey = document.querySelector('.journey');
const chapters = [...document.querySelectorAll('.journey-chapter')];
const chapterLinks = [...document.querySelectorAll('.journey-nav a')];
const mainArt = document.querySelector('.journey-art');
document.documentElement.classList.add('has-story');
const mobileArt = chapters.map(chapter => {
  const frame = document.createElement('div');
  frame.className = 'mobile-coordination';
  frame.setAttribute('aria-hidden', 'true');
  const art = mainArt.cloneNode(true);
  frame.append(art);
  chapter.append(frame);
  return art;
});
const finale = document.querySelector('.circle-finale');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const mobile = matchMedia('(max-width: 760px)');
const connection = navigator.connection;
const clamp = n => Math.min(1, Math.max(0, n));
const word = key => copy[document.documentElement.lang]?.[key] || copy.en[key];
let active = 0;
let started = false;
let finished = false;
let userPaused = false;
let inView = false;
let explicitPlay = false;
const autoAllowed = () => !mobile.matches && !reducedMotion.matches && !connection?.saveData;
function filmLabels() {
  motionButton.textContent = word(finished ? 'replayFilm' : video.paused ? (started ? 'resumeFilm' : 'playFilm') : 'pauseFilm');
  beat.textContent = word(video.currentTime < 4 ? 'beatGive' : video.currentTime < 9 ? 'beatReceive' : 'beatContinue');
  screen.classList.toggle('film-running', !video.paused && video.currentTime > 1.1);
  screen.classList.toggle('film-complete', finished);
  screen.style.setProperty('--film-percent', `${video.duration ? 100 * video.currentTime / video.duration : 0}%`);
}
function setPhase(index) {
  active = index;
  chapterLinks.forEach((link, i) => {
    if (i === index) link.setAttribute('aria-current', 'step');
    else link.removeAttribute('aria-current');
  });

}
function setLanguage(lang) {
  if (!copy[lang]) lang = 'en';
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-copy]').forEach(el => { el.innerHTML = word(el.dataset.copy); });
  document.querySelectorAll('[data-lang]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.lang === lang)));
  document.querySelectorAll('a[href^="faq"]').forEach(el => { el.href = lang === 'en' ? 'faq.html' : `faq.${lang}.html`; });
  setPhase(active);
  updateStory();
  filmLabels();
  scheduleStory();
  try { localStorage.setItem('chama-landing-language', lang); } catch (_) { /* Optional storage. */ }
}
async function playFilm() {
  if (!video.getAttribute('src')) { video.src = video.dataset.src; video.load(); }
  try { await video.play(); } catch (_) { filmLabels(); /* The visible button remains available if autoplay is blocked. */ }
}
function syncFilm() {
  if (!inView || document.hidden || userPaused || finished || (!explicitPlay && !autoAllowed())) {
    video.pause();
    filmLabels();
    return;
  }
  void playFilm();
}
motionButton.addEventListener('click', () => {
  if (!video.paused) { userPaused = true; video.pause(); }
  else {
    if (finished) { video.currentTime = 0; finished = false; }
    userPaused = false;
    explicitPlay = true;
    void playFilm();
  }
});
video.addEventListener('playing', () => {
  if (!inView || document.hidden || userPaused) { video.pause(); return; }
  started = true;
  video.classList.add('is-playing');
  filmLabels();
});
video.addEventListener('pause', filmLabels);
video.addEventListener('timeupdate', filmLabels);
video.addEventListener('ended', () => { finished = true; filmLabels(); });
video.addEventListener('error', () => {
  video.classList.remove('is-playing');
  screen.classList.remove('film-running');
  motionButton.hidden = true;
});
new IntersectionObserver(entries => {
  inView = entries[0].isIntersecting;
  syncFilm();
}, { threshold: .15 }).observe(screen);
reducedMotion.addEventListener('change', () => { explicitPlay = false; syncFilm(); scheduleStory(); });
mobile.addEventListener('change', () => { explicitPlay = false; syncFilm(); });
connection?.addEventListener('change', syncFilm);
document.addEventListener('visibilitychange', syncFilm);

let scheduled = false;
function updateStory() {
  scheduled = false;
  const h = innerHeight;
  const heroRect = cinema.getBoundingClientRect();
  document.querySelector('.nav').classList.toggle('past-cinema', heroRect.bottom < 100);
  // Keep the mobile video exactly aligned with its inline poster, including translated headlines.
  screen.style.setProperty('--mobile-video-top', `${poster.offsetTop}px`);
  screen.style.setProperty('--mobile-video-height', `${poster.offsetHeight}px`);
  const exit = reducedMotion.matches || mobile.matches ? 0 : clamp(-heroRect.top / (h * .45));
  cinema.style.setProperty('--cinema-inset', `${exit * 30}px`);
  cinema.style.setProperty('--cinema-radius', `${exit * 18}px`);
  let closest = 0, distance = Infinity;
  const rects = chapters.map(chapter => chapter.getBoundingClientRect());
  rects.forEach((rect, i) => {
    const d = Math.abs((rect.top + rect.bottom) / 2 - h * .5);
    if (d < distance) { closest = i; distance = d; }
  });
  if (closest !== active) setPhase(closest);
  const agree = reducedMotion.matches ? Number(active >= 1) : clamp((h * .3 - rects[1].top) / (h * .9));
  const trade = reducedMotion.matches ? Number(active === 2) : clamp((h * .3 - rects[2].top) / (h * .75));
  const meet = clamp((h * .9 - rects[0].top) / (h * .6));
  drawCoordination(mainArt, meet, agree, trade);
  mobileArt.forEach((art, i) => drawCoordination(art, 1, Number(i >= 1), Number(i === 2)));
  journey.style.setProperty('--journey-bg', `rgb(${236 - Math.round(trade * 8)} ${236 - Math.round(trade * 5)} ${223 - Math.round(trade * 7)})`);
  const reveal = reducedMotion.matches ? 1 : clamp((h - finale.getBoundingClientRect().top) / (h * .85));
  finale.style.setProperty('--circle-aperture', `${18 + reveal * 92}%`);
  finale.style.setProperty('--circle-scale', 1.12 - reveal * .12);
}
// This example is Exchange: the seller funds sats; the buyer pays local money.
// Both confirmations precede release. Chama's mark never represents custody.
function drawCoordination(art, meet, agree, trade) {
  const funding = clamp((agree - .35) / .4);
  const locked = clamp((funding - .75) * 4);
  const payment = clamp((trade - .05) / .35);
  const sellerConfirm = clamp((trade - .43) / .07);
  const buyerConfirm = clamp((trade - .53) / .07);
  const release = clamp((trade - .65) / .23);
  const received = clamp((trade - .9) / .1);
  const values = {
    '--meet-opacity': 1 - clamp(agree * 4),
    '--match-offset': 1 - meet,
    '--arbiter-opacity': clamp(agree * 3),
    '--arbiter-offset': 1 - clamp(agree * 2),
    '--agree-opacity': clamp(agree * 4) * (1 - clamp(trade * 6)),
    '--cash-opacity': clamp(trade * 15) * (1 - clamp((trade - .42) * 12)),
    '--cash-x': `${17.5 + 65 * payment}%`,
    '--vault-opacity': locked * (1 - clamp((trade - .63) * 10)),
    '--coin-opacity': trade > .6 ? clamp((trade - .63) * 15) * (1 - received) : clamp(funding * 5) * (1 - locked),
    '--coin-x': `${trade > .6 ? 50 - 32.5 * release : 82.5 - 32.5 * funding}%`,
    '--buyer-confirm': buyerConfirm,
    '--seller-confirm': sellerConfirm,
    '--received-opacity': received,
    '--trade-routes': clamp(trade * 6)
  };
  Object.entries(values).forEach(([key,value]) => art.style.setProperty(key,value));
  const key = trade > .9 ? 'statusTrade' : trade > .64 ? 'statusRelease' : trade > .43 ? 'statusConfirm' : trade > .02 ? 'statusPay' : agree > .3 ? 'statusAgree' : 'statusMeet';
  art.querySelector('.journey-status').textContent = word(key);
}
function scheduleStory() { if (!scheduled) { scheduled = true; requestAnimationFrame(updateStory); } }
addEventListener('scroll', scheduleStory, { passive: true });
addEventListener('resize', scheduleStory);
poster.addEventListener('load', scheduleStory);
document.fonts?.ready.then(scheduleStory);
document.querySelectorAll('[data-lang]').forEach(button => button.addEventListener('click', () => setLanguage(button.dataset.lang)));
try { const saved = localStorage.getItem('chama-landing-language'); if (saved && copy[saved]) setLanguage(saved); } catch (_) { /* Readable without storage. */ }
setPhase(0);
filmLabels();
updateStory();
