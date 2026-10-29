/* help.html 独立帮助页专用：主题与字号跟随主界面（同源 localStorage），不含任何业务逻辑 */
(function () {
  function apply() {
    var t = localStorage.getItem('gnTheme') || 'auto';
    if (t === 'auto') t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    var fs = parseInt(localStorage.getItem('gnFontSize'), 10);
    if (fs >= 10 && fs <= 50) document.documentElement.style.setProperty('--fs-post', fs + 'px');
  }
  apply();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply);
  window.addEventListener('storage', apply);
})();
