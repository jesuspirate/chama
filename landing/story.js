// Native scrolling is never intercepted; every chapter also works without motion.
document.querySelectorAll('[data-copy]').forEach(el => { copy.en[el.dataset.copy] = el.innerHTML; });
const cinema = document.querySelector('.cinema');
const screen = document.querySelector('.cinema-screen');
const poster = document.querySelector('.cinema-poster');
const video = document.querySelector('.hero-video');
const filmVersion = new URLSearchParams(location.search).get('film');
const filmPlaylist = ['original', 'varied'].includes(filmVersion) ? [
  'img/chama-circle-story-v13.mp4',
  `img/circle-turns/collector-2${filmVersion === 'varied' ? '-v2' : ''}.mp4`,
  `img/circle-turns/collector-3${filmVersion === 'varied' ? '-v2' : ''}.mp4`,
  'img/circle-turns/collector-5.mp4'
] : null;
let filmIndex = 0;
if (filmPlaylist) video.dataset.src = filmPlaylist[0];
const filmStill = document.createElement('canvas');
filmStill.className = 'cinema-still';
filmStill.setAttribute('aria-hidden', 'true');
video.after(filmStill);
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
const autoAllowed = () => !reducedMotion.matches && !connection?.saveData;
let progressFrame = 0;
function paintFilmProgress() {
  screen.style.setProperty('--film-fraction', finished ? 1 : video.duration ? (filmIndex + clamp(video.currentTime / video.duration)) / (filmPlaylist?.length || 1) : 0);
}
function animateFilmProgress() {
  cancelAnimationFrame(progressFrame);
  paintFilmProgress();
  progressFrame = !video.paused && !video.ended && !document.hidden ? requestAnimationFrame(animateFilmProgress) : 0;
}
function holdFinalFrame() {
  // Preserve the exact decoded frame and crop, without a moving video layer.
  filmStill.width = video.videoWidth;
  filmStill.height = video.videoHeight;
  const context = filmStill.getContext('2d');
  if (!context || !filmStill.width) return;
  context.drawImage(video, 0, 0);
  screen.classList.add('film-still');
}
function filmLabels() {
  motionButton.textContent = word(finished ? 'replayFilm' : video.paused ? (started ? 'resumeFilm' : 'playFilm') : 'pauseFilm');
  beat.textContent = word(video.currentTime < 2 ? 'beatGive' : video.currentTime < 4 ? 'beatReceive' : 'beatContinue');
  screen.classList.toggle('film-running', !video.paused && video.currentTime > .35);
  screen.classList.toggle('film-complete', finished);
  document.querySelector('.film-context').textContent = finished ? '' : word('filmContext');
  paintFilmProgress();
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
  syncThemeButton();
  document.dispatchEvent(new Event('chama-language'));
  sizeFilm();
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
    if (finished) { video.currentTime = 0; finished = false; screen.classList.remove('film-still'); }
    userPaused = false;
    explicitPlay = true;
    void playFilm();
  }
});
video.addEventListener('playing', () => {
  if (!inView || document.hidden || userPaused) { video.pause(); return; }
  started = true;
  if (filmPlaylist) {
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => screen.classList.remove('film-still'));
    else screen.classList.remove('film-still');
  }
  video.classList.add('is-playing');
  animateFilmProgress();
  filmLabels();
});
video.addEventListener('pause', () => { animateFilmProgress(); filmLabels(); });
video.addEventListener('seeking', paintFilmProgress);
video.addEventListener('timeupdate', filmLabels);
video.addEventListener('ended', () => {
  holdFinalFrame();
  if (filmPlaylist) {
    filmIndex = (filmIndex + 1) % filmPlaylist.length;
    video.src = filmPlaylist[filmIndex];
    video.load();
    syncFilm();
  } else finished = true;
  animateFilmProgress();
  filmLabels();
});
video.addEventListener('error', () => {
  video.classList.remove('is-playing');
  screen.classList.remove('film-running');
  motionButton.hidden = true;
});
new IntersectionObserver(entries => {
  inView = entries[0].isIntersecting;
  syncFilm();
}, { threshold: .15 }).observe(screen);
reducedMotion.addEventListener('change', () => { explicitPlay = false; sizeFilm(); syncFilm(); scheduleStory(); });
mobile.addEventListener('change', () => { explicitPlay = false; syncFilm(); });
connection?.addEventListener('change', syncFilm);
document.addEventListener('visibilitychange', syncFilm);

let scheduled = false;
const coordinationFrames = new WeakMap();
let exitFrame = 0, exitTarget = 0, exitPosition = 0, exitTime = 0;
function paintHeroExit(time) {
  const dt = Math.min(50, time - (exitTime || time - 16.67));
  exitTime = time;
  exitPosition += (exitTarget - exitPosition) * (1 - Math.exp(-dt / 65));
  if (Math.abs(exitTarget - exitPosition) < .0001) exitPosition = exitTarget;
  cinema.style.setProperty('--cinema-scale', 1 - exitPosition * 60 / innerWidth);
  cinema.style.setProperty('--cinema-radius', `${exitPosition * 18}px`);
  exitFrame = exitPosition !== exitTarget ? requestAnimationFrame(paintHeroExit) : 0;
  if (!exitFrame) exitTime = 0;
}
function setHeroExit(value) {
  exitTarget = value;
  if (reducedMotion.matches || mobile.matches) exitPosition = value;
  if (!exitFrame) exitFrame = requestAnimationFrame(paintHeroExit);
}
function sizeFilm() {
  // Geometry only changes on resize/load, never during scrolling.
  if (!mobile.matches || !reducedMotion.matches) return;
  screen.style.setProperty('--mobile-video-top', `${poster.offsetTop}px`);
  screen.style.setProperty('--mobile-video-height', `${poster.offsetHeight}px`);
}
function updateStory() {
  scheduled = false;
  const h = innerHeight;
  const heroRect = cinema.getBoundingClientRect();
  document.querySelector('.nav').classList.toggle('past-cinema', heroRect.bottom < 100);
  const exit = reducedMotion.matches || mobile.matches ? 0 : clamp(-heroRect.top / (h * .45));
  // Scale the composited surface; do not resize and recrop a playing video.
  setHeroExit(exit);
  let closest = 0, distance = Infinity;
  const rects = chapters.map(chapter => chapter.getBoundingClientRect());
  rects.forEach((rect, i) => {
    const d = Math.abs((rect.top + rect.bottom) / 2 - h * .5);
    if (d < distance) { closest = i; distance = d; }
  });
  if (closest !== active) setPhase(closest);
  const agree = reducedMotion.matches ? Number(active >= 1) : clamp((h * (mobile.matches ? .6 : .85) - rects[1].top) / (h * (mobile.matches ? .7 : .55)));
  const trade = reducedMotion.matches ? Number(active === 2) : clamp((h * (mobile.matches ? .5 : .3) - rects[2].top) / (h * (mobile.matches ? 1 : .75)));
  const meet = clamp((h * .9 - rects[0].top) / (h * .6));
  drawCoordination(mainArt, meet, agree, trade);
  if (mobile.matches && reducedMotion.matches) mobileArt.forEach((art, i) => drawCoordination(art, 1, Number(i >= 1), Number(i === 2)));
  journey.style.setProperty('--journey-bg', `rgb(${236 - Math.round(trade * 8)} ${236 - Math.round(trade * 5)} ${223 - Math.round(trade * 7)})`);
  const reveal = reducedMotion.matches ? 1 : clamp((h - finale.getBoundingClientRect().top) / (h * .85));
  finale.style.setProperty('--circle-aperture', `${18 + reveal * 92}%`);
  finale.style.setProperty('--circle-scale', 1.12 - reveal * .12);
}
// This example is Exchange: the seller funds sats; the buyer pays local money.
// Receipt badges follow each asset: fiat reaches Daniel first, then sats reach Daneka.
// Chama's mark never represents custody.
function drawCoordination(art, meet, agree, trade) {
  const frame = `${art.clientWidth}:${art.clientHeight}:${meet.toFixed(4)}:${agree.toFixed(4)}:${trade.toFixed(4)}:${document.documentElement.lang}`;
  if (coordinationFrames.get(art) === frame) return;
  coordinationFrames.set(art, frame);
  const funding = clamp((agree - .35) / .4);
  const locked = clamp((funding - .75) * 4);
  // Emphasize the counterparties once the agreement settles, through completion.
  const exchangeFocus = clamp((agree - .65) / .25);
  const payment = clamp((trade - .2) / .22);
  const sellerReceived = clamp((trade - .43) / .07);
  const release = clamp((trade - .65) / .23);
  const received = clamp((trade - .9) / .1);
  const values = {
    '--exchange-focus': exchangeFocus,
    '--meet-opacity': 1 - clamp(agree * 4),
    '--match-offset': 1 - meet,
    '--arbiter-opacity': clamp(agree * 2),
    '--arbiter-rise': `${(1 - clamp(agree * 2)) * 28}px`,
    '--coord-caption': 1 - clamp(agree * 3),
    '--cash-route-opacity': clamp((trade - .18) / .06) * (1 - clamp((trade - .55) * 10)),
    '--arbiter-offset': 1 - clamp(agree * 2),
    '--agree-opacity': clamp(agree * 4) * (1 - clamp(trade * 6)),
    '--cash-opacity': clamp((trade - .18) / .04) * (1 - clamp((trade - .42) * 12)),
    '--cash-x': `${17.5 + 65 * payment}%`,
    '--vault-opacity': locked * (1 - clamp((trade - .63) * 10)),
    '--coin-opacity': clamp(funding * 5) * (1 - received),
    '--coin-x': `${trade > .6 ? 50 - 32.5 * release : 82.5 - 32.5 * funding}%`,
    '--buyer-received': received,
    '--seller-received': sellerReceived,
    '--trade-routes': clamp(trade * 6)
  };
  Object.entries(values).forEach(([key,value]) => art.style.setProperty(key,value));
  // Clip center-to-center connectors to the actual circular portrait edges.
  // DOM bounds already include the border; overlap its edge by one pixel.
  const bounds = art.getBoundingClientRect();
  const portraits = ['buyer', 'arbiter', 'seller'].map(role => art.querySelector(`.portrait-${role}`).getBoundingClientRect());
  if (bounds.width && bounds.height) {
    const point = (x, y) => `${(x - bounds.left) * 600 / bounds.width} ${(y - bounds.top) * 600 / bounds.height}`;
    const edge = (a, b) => {
      const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
      const dx = b.left + b.width / 2 - ax, dy = b.top + b.height / 2 - ay;
      const radius = a.width / 2 - 1;
      const distance = Math.hypot(dx, dy) || 1;
      return point(ax + dx / distance * radius, ay + dy / distance * radius);
    };
    const [buyer, arbiter, seller] = portraits;
    art.querySelector('.arbiter-lines').setAttribute('d', `M${edge(buyer, arbiter)}L${edge(arbiter, buyer)}M${edge(arbiter, seller)}L${edge(seller, arbiter)}`);
  }

  const key = trade > .9 ? 'statusTrade' : trade > .64 ? 'statusRelease' : trade > .43 ? 'statusConfirm' : trade > .18 ? 'statusPay' : agree > .3 ? 'statusAgree' : 'statusMeet';
  art.querySelector('.journey-status').textContent = word(key);
}
function scheduleStory() { if (!scheduled) { scheduled = true; requestAnimationFrame(updateStory); } }
addEventListener('scroll', scheduleStory, { passive: true });
addEventListener('resize', () => { sizeFilm(); scheduleStory(); });
poster.addEventListener('load', () => { sizeFilm(); scheduleStory(); });
document.fonts?.ready.then(() => { sizeFilm(); scheduleStory(); });
document.querySelectorAll('[data-lang]').forEach(button => button.addEventListener('click', () => setLanguage(button.dataset.lang)));
try { const saved = localStorage.getItem('chama-landing-language'); if (saved && copy[saved]) setLanguage(saved); } catch (_) { /* Readable without storage. */ }
setPhase(0);
filmLabels();
updateStory();

// Keep the existing Chama theme preference across the redesign.
function syncThemeButton(){
  const dark=document.documentElement.dataset.theme==='dark';
  const labels={en:['Use dark mode','Use light mode'],es:['Usar modo oscuro','Usar modo claro'],fr:['Activer le mode sombre','Activer le mode clair']};
  const button=document.querySelector('.theme-toggle');
  button.setAttribute('aria-label',(labels[document.documentElement.lang]||labels.en)[Number(dark)]);
  button.setAttribute('aria-pressed',String(dark));
  button.innerHTML=dark ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/></svg>';
  document.querySelector('meta[name="theme-color"]').content=dark?'#11100e':'#f3f0e7';
}
document.querySelector('.theme-toggle').addEventListener('click',()=>{
  const theme=document.documentElement.dataset.theme==='dark'?'light':'dark';
  document.documentElement.dataset.theme=theme;
  try{localStorage.setItem('chama-theme',theme)}catch(_){}
  syncThemeButton();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',event=>{
  try{if(localStorage.getItem('chama-theme'))return}catch(_){}
  document.documentElement.dataset.theme=event.matches?'dark':'light';syncThemeButton();
});
syncThemeButton();
