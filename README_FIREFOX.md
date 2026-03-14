Firefox support notes

Installation (temporary load for testing):

1. Open Firefox (Developer Edition or current stable).
2. Navigate to `about:debugging#/runtime/this-firefox`.
3. Click "Load Temporary Add-on" and select `manifest.json` from this repository root.

Notes and compatibility:

- This extension uses Manifest V3 features (service worker). Firefox's MV3 support has improved but may differ from Chromium; if the background service worker does not behave identically, consider testing in recent Firefox Developer/ Nightly builds.
- The extension uses `chrome.*` APIs; Firefox supports many `chrome.*` APIs but if you run into Promise-based vs callback differences, consider adding a `webextension-polyfill` shim.
- If webhook forwarding or IndexedDB behave differently, check the Browser Console (Ctrl+Shift+J) for errors.

If you want, I can add a `browser` polyfill and a Firefox-specific manifest variant, or include automated packaging instructions.
