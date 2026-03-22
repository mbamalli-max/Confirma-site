# Confirma Marketing Site

Static marketing website for Confirma, prepared for deployment on Vercel.

## Local preview

From this folder:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Before deploying

Update the production PWA URL in `site.js`:

```js
window.CONFIRMA_APP_URL = "https://your-confirma-app.vercel.app";
```

That shared value controls the install links and visible app URL on `get-the-app.html`.

## Deploy to Vercel

1. Push this repo to GitHub, GitLab, or Bitbucket.
2. Import the repo into Vercel.
3. Keep the project as a static site.
4. Deploy.

`vercel.json` enables clean URLs, so pages like `about.html` are available as `/about` on Vercel.

## Pages

- `/`
- `/entrepreneurs`
- `/banks`
- `/how-it-works`
- `/about`
- `/get-the-app`
