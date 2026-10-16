// Applies the saved light/dark mode before the app bundle loads (moved out
// of index.html so the content policy can forbid inline scripts, M8).
(function () {
  try {
    var mode = localStorage.getItem("chama_theme_mode");
    var light = mode === "light" || (mode === "system" &&
      window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
    if (light) {
      // Appended <style> outranks the block above by order (no
      // !important — theme.ts's runtime inline styles must still win
      // if the user switches back to dark mid-session).
      var st = document.createElement("style");
      st.textContent = "html,body,#root{background:#f4f3ee;color:#1d1c24}";
      document.head.appendChild(st);
      document.documentElement.style.colorScheme = "light";
    }
  } catch (e) {}
})();
