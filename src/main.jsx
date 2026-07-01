import React from 'react'
import ReactDOM from 'react-dom/client'
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
