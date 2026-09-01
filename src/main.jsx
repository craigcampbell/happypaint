import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/fredoka/wght.css'
import '@fontsource-variable/nunito-sans/wght.css'
import App from './App.jsx'
import './index.css'

// iOS Safari: stop the browser from pinch- / double-tap-zooming the whole PAGE.
// The canvas runs its own pinch-zoom off pointer events, so blocking Safari's
// non-standard gesture events doesn't affect drawing — it only prevents the
// "site zooms way in and taps miss" behaviour on iPad. Listeners are passive:false
// so preventDefault() takes effect.
for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false })
}

// Long-press while drawing: Android Chrome's "Save image / Copy image" sheet and
// iOS's Copy · Look Up callout are both driven by the `contextmenu` event, which
// CSS cannot reach — user-select/-webkit-touch-callout stop the SELECTION, but
// the event still fires, so a finger landing on a chip, the quick bar, the tool
// rail or any <img> pops the platform menu over the canvas mid-stroke. The
// overlay canvas prevents it on itself (App.jsx); every other surface a finger
// can hit needs the same. Cancel it document-wide in the CAPTURE phase, except
// where kids genuinely need the menu: text fields (paste) and links.
const CONTEXT_MENU_ALLOWED = 'input, textarea, [contenteditable="true"], a[href]'
document.addEventListener("contextmenu", (event) => {
  if (event.target?.closest?.(CONTEXT_MENU_ALLOWED)) return
  event.preventDefault()
}, { capture: true })

// The same long press turning into a drag lifts a ghost copy of an image off the
// page (every <img> is draggable by default). Text drag inside a field is fine.
document.addEventListener("dragstart", (event) => {
  const tag = event.target?.tagName
  if (tag === "IMG" || tag === "CANVAS") event.preventDefault()
}, { capture: true })

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

if ("serviceWorker" in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Offline support is best effort in unsupported browsers.
      });
    });
  } else {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((registration) => registration.unregister());
    });
  }
}
