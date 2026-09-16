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
const status = document.querySelector('.journey-status');
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
  status.textContent = word(['statusMeet', 'statusAgree', 'statusTrade'][index]);
}
function setLanguage(lang) {
  if (!copy[lang]) lang = 'en';
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-copy]').forEach(el => { el.innerHTML = word(el.dataset.copy); });
  document.querySelectorAll('[data-lang]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.lang === lang)));
  document.querySelectorAll('a[href^="faq"]').forEach(el => { el.href = lang === 'en' ? 'faq.html' : `faq.${lang}.html`; });
  setPhase(active);
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
  const agree = reducedMotion.matches ? Number(active >= 1) : clamp((h * .9 - rects[1].top) / (h * .65));
  const trade = reducedMotion.matches ? Number(active === 2) : clamp((h * .85 - rects[2].top) / (h * .7));
  const vars = {
    '--arbiter-opacity': agree,
    '--arbiter-y': `${-35 - 15 * agree}%`,
    '--line-offset': 1000 * (1 - agree),
    '--token-opacity': clamp(agree * 2),
    '--token-x': `${50 + 30 * trade}%`,
    '--lock-opacity': agree * (1 - clamp(trade * 3)),
    '--bitcoin-opacity': clamp(trade * 3),
    '--halo-opacity': clamp((trade - .6) * 2.5),
    '--halo-scale': 1 + trade * .15,
    '--orbit-angle': `${reducedMotion.matches ? 0 : (agree + trade) * 16}deg`,
    '--journey-bg': `rgb(${236 - Math.round(trade * 8)} ${236 - Math.round(trade * 5)} ${223 - Math.round(trade * 7)})`
  };
  Object.entries(vars).forEach(([key, value]) => journey.style.setProperty(key, value));
  const reveal = reducedMotion.matches ? 1 : clamp((h - finale.getBoundingClientRect().top) / (h * .85));
  finale.style.setProperty('--circle-aperture', `${18 + reveal * 92}%`);
  finale.style.setProperty('--circle-scale', 1.12 - reveal * .12);
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
