// The menu bar's drop-downs (Tools, Account): only one open at a time; they close on a click elsewhere, on Escape,
// and after choosing something. Plain <details>, so they still open and close without this file.
(() => {
  const menus = [...document.querySelectorAll('details.navmenu')];
  const closeAll = (except) => menus.forEach((d) => { if (d !== except) d.open = false; });
  menus.forEach((d) => {
    d.addEventListener('toggle', () => { if (d.open) closeAll(d); });
    d.querySelector('.navmenu-panel').addEventListener('click', (e) => { if (e.target.closest('a, button')) d.open = false; });
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('details.navmenu')) closeAll(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = menus.find((d) => d.open);
    if (open) { open.open = false; open.querySelector('summary').focus(); }
  });
})();
