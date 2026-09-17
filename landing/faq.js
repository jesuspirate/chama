// Preserve the landing page's preference without depending on its story DOM.
const themeButton = document.querySelector('.theme-toggle');
const themeLabels = {
  en: ['Use dark mode', 'Use light mode'],
  es: ['Usar modo oscuro', 'Usar modo claro'],
  fr: ['Activer le mode sombre', 'Activer le mode clair'],
};
function syncTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  themeButton.setAttribute('aria-pressed', String(dark));
  themeButton.setAttribute('aria-label', (themeLabels[document.documentElement.lang] || themeLabels.en)[Number(dark)]);
  document.querySelector('meta[name="theme-color"]').content = dark ? '#11100e' : '#f3f0e7';
}
themeButton.hidden = false;
themeButton.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('chama-theme', theme); } catch (_) {}
  syncTheme();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', event => {
  try { if (localStorage.getItem('chama-theme')) return; } catch (_) {}
  document.documentElement.dataset.theme = event.matches ? 'dark' : 'light';
  syncTheme();
});
// Older links to troubleshooting and glossary still land on relevant answers.
if (['#trouble', '#glossary'].includes(location.hash)) {
  document.querySelector('#safety').scrollIntoView();
}
syncTheme();
