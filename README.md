# Unity programmer portfolio

A dependency-free static site designed for GitHub Pages. The site is generated from the Markdown files under `src/content`.

## Local build

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build.ps1
```

Open `dist/index.html` after the build. The site does not need a local server.

## Add a work or note

Copy one of the Markdown files in `src/content/works` or `src/content/notes`. Keep the front matter fields and update the values. Run the build command again.

## Deploy

Push the repository to GitHub's default branch. The included workflow publishes `dist` to GitHub Pages. In the repository settings, choose **GitHub Actions** as the Pages source.

