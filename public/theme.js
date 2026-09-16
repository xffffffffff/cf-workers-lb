(() => {
  let theme
  try { theme = localStorage.getItem('worker-lb-theme') } catch { /* Storage may be unavailable. */ }
  if (theme !== 'light' && theme !== 'dark') {
    theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#101113' : '#ffffff')
})()
