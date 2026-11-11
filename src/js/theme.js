'use strict';
// Helles/dunkles Design. Läuft vor dem Rest der Seite, damit beim Start nichts aufblitzt.
// Ohne eigene Wahl gilt die Einstellung des Betriebssystems.

(function () {
  const KEY = 'protokoll-el-theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const stored = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const current = () => stored() || (system.matches ? 'dark' : 'light');

  function apply() {
    const theme = current();
    document.documentElement.dataset.theme = theme;
    const btn = document.querySelector('[data-theme-toggle]');
    if (btn) {
      btn.textContent = theme === 'dark' ? '☀️' : '🌙';
      btn.title = theme === 'dark' ? 'Helles Design' : 'Dunkles Design';
    }
  }

  apply();
  system.addEventListener('change', apply);
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.querySelector('[data-theme-toggle]')?.addEventListener('click', () => {
      try { localStorage.setItem(KEY, current() === 'dark' ? 'light' : 'dark'); } catch { /* bleibt bei der Systemeinstellung */ }
      apply();
    });
  });
})();
