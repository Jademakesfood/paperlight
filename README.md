# Paperlight

Paperlight is a private, installable document scanner for iPhone and modern browsers. It runs as a static Progressive Web App: there is no account, database, document server, subscription, or analytics.

## What it does

- Captures pages with the iPhone camera or imports from Photos
- Crops and corrects the page using four draggable corners
- Applies automatic, color, grayscale, and black-and-white enhancements
- Rotates, reorders, adds, and removes pages
- Stores the document library locally in IndexedDB
- Recognizes English text on-device with Tesseract.js
- Exports PDF, Word (`.docx`), and JPEG files
- Uses the iOS share sheet when supported, with file download as a fallback
- Caches the app for offline use after the first visit

OCR downloads its English recognition model on first use. The scanned image is processed locally and is not uploaded with that request.

## Run locally

```bash
npm install
npm run dev
```

Open the local address Vite prints. Use **or try a sample document** to explore the complete workflow without selecting a personal file.

## Build

```bash
npm run build
```

The ready-to-host static site is created in `dist/`.

## Free GitHub Pages deployment

1. Create a new GitHub repository and upload this project.
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, choose **GitHub Actions**.
4. Push to the `main` branch or run the included workflow manually.
5. GitHub will show the free public site address after deployment.

The included workflow builds and publishes the app automatically whenever `main` changes. The app supports repository subpaths, so it works at addresses such as `https://username.github.io/paperlight/`.

## Install on iPhone

1. Open the deployed address in Safari.
2. Tap Safari’s **Share** button.
3. Choose **Add to Home Screen** and then **Add**.
4. Open Paperlight from the new Home Screen icon.

Documents belong to the browser installation on that phone. Clearing Safari website data or deleting the PWA can remove its local library, so export important scans to Files or another storage location.
