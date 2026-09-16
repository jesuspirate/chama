// The page stays readable without JavaScript. Motion follows native scrolling.
document.querySelectorAll('[data-copy]').forEach(el => { copy.en[el.dataset.copy] = el.innerHTML; });
const chapters = [...document.querySelectorAll('.chapter')];
const scenes = [...document.querySelectorAll('.scene')];
const chapterLinks = [...document.querySelectorAll('.chapter-nav a')];
const sceneKeys = ['meetLabel', 'agreeLabel', 'tradeLabel', 'gatherLabel'];
let active = 0;
function setScene(index) {
  active = index;
  scenes.forEach((scene, i) => scene.classList.toggle('is-active', i === index));
  chapterLinks.forEach((link, i) => {
    if (i === index) link.setAttribute('aria-current', 'step');
    else link.removeAttribute('aria-current');
  });
  document.querySelector('.scene-count').textContent = `0${index + 1} / 04`;
  const word = document.querySelector('.scene-word');
  word.dataset.copy = sceneKeys[index];
  word.textContent = copy[document.documentElement.lang]?.[sceneKeys[index]] || copy.en[sceneKeys[index]];
}
function setLanguage(lang) {
  if (!copy[lang]) lang = 'en';
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-copy]').forEach(el => { el.innerHTML = copy[lang][el.dataset.copy] || copy.en[el.dataset.copy]; });
  document.querySelectorAll('[data-lang]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.lang === lang)));
  document.querySelectorAll('a[href^="faq"]').forEach(el => el.href = lang === 'en' ? 'faq.html' : `faq.${lang}.html`);
  setScene(active);
  if (document.querySelector('.hero-video')?.getAttribute('src')) motionLabel();
  try { localStorage.setItem('chama-landing-language', lang); } catch (_) { /* Storage is optional. */ }
}
document.querySelectorAll('[data-lang]').forEach(button => button.addEventListener('click', () => setLanguage(button.dataset.lang)));
try { const saved = localStorage.getItem('chama-landing-language'); if (saved && copy[saved]) setLanguage(saved); } catch (_) { /* Readable without storage. */ }
let scheduled = false;
function updateStory() {
  scheduled = false;
  const target = window.innerHeight * .48;
  let closest = 0, distance = Infinity;
  chapters.forEach((chapter, i) => {
    const rect = chapter.getBoundingClientRect();
    const current = Math.abs((rect.top + rect.bottom) / 2 - target);
    if (current < distance) { distance = current; closest = i; }
  });
  if (closest !== active) setScene(closest);
}
function scheduleStory() { if (!scheduled) { scheduled = true; requestAnimationFrame(updateStory); } }
addEventListener('scroll', scheduleStory, { passive: true });
addEventListener('resize', scheduleStory);
updateStory();

// Load ambient footage only when it can be seen and motion/data preferences allow it.
const hero = document.querySelector('.hero-image');
const video = document.querySelector('.hero-video');
const motionButton = document.querySelector('.motion-toggle');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const connection = navigator.connection;
let inView = false;
let userPaused = false;
const motionAllowed = () => !reducedMotion.matches && !connection?.saveData;
function motionLabel() {
  const key = video.paused ? 'playMotion' : 'pauseMotion';
  motionButton.textContent = copy[document.documentElement.lang]?.[key] || copy.en[key];
}
function syncMotion() {
  if (!motionAllowed()) {
    video.pause();
    video.classList.remove('is-playing');
    motionButton.hidden = true;
    return;
  }
  if (!inView || document.hidden || userPaused) {
    video.pause();
    motionLabel();
    return;
  }
  if (!video.getAttribute('src')) {
    video.src = video.dataset.src;
    video.load();
  }
  video.play().then(motionLabel).catch(() => {
    // Autoplay can be blocked. Keep the poster and offer explicit playback.
    motionButton.hidden = false;
    motionLabel();
  });
}
video.addEventListener('playing', () => {
  if (!motionAllowed() || !inView || document.hidden || userPaused) { syncMotion(); return; }
  video.classList.add('is-playing');
  motionButton.hidden = false;
  motionLabel();
});
video.addEventListener('pause', motionLabel);
video.addEventListener('error', () => {
  video.classList.remove('is-playing');
  motionButton.hidden = true;
});
motionButton.addEventListener('click', () => {
  userPaused = !video.paused;
  syncMotion();
});
new IntersectionObserver(entries => {
  inView = entries[0].isIntersecting;
  syncMotion();
}, { threshold: .05 }).observe(hero);
reducedMotion.addEventListener('change', syncMotion);
connection?.addEventListener('change', syncMotion);
addEventListener('visibilitychange', syncMotion);
