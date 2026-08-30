try {
  const theme = localStorage.getItem('ferrum:theme');
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
  }
} catch {
  // Storage can be disabled; the CSS default remains usable.
}
