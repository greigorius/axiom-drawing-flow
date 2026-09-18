# Vendored browser libraries

React, ReactDOM and Babel Standalone, served from this site rather than from a CDN.

**Why.** On 18 Sep 2026 unpkg.com failed to serve `react.development.js` — the request
came back with no CORS header and `net::ERR_FAILED` — and the whole cockpit went down
with `React is not defined` in every component. The deploy was fine; the CDN was not.
There is no build step here (JSX is transformed in the browser by Babel Standalone), so
these three files are the app's entire runtime. A third party being down should not take
the site with it.

**Versions**, pinned to what `index.html` loaded before:

| File | Package | Version |
|---|---|---|
| `react.production.min.js` | react | 18.3.1 |
| `react-dom.production.min.js` | react-dom | 18.3.1 |
| `babel.min.js` | @babel/standalone | 7.27.1 |

Production builds, not development. The site is production; the dev builds it used to
load are larger and spend time on warnings nobody reads. To go back for local debugging,
swap in `react.development.js` / `react-dom.development.js` from the same package version.

**To update**, in a scratch folder outside this repo:

```
npm install react@18 react-dom@18 @babel/standalone@7.27.1
cp node_modules/react/umd/react.production.min.js             public/vendor/
cp node_modules/react-dom/umd/react-dom.production.min.js     public/vendor/
cp node_modules/@babel/standalone/babel.min.js                public/vendor/
```

Do not add these to the project's `package.json` — nothing imports them, they are static
assets the browser loads directly.

**Worth knowing:** `babel.min.js` is ~3 MB and every page load transforms the JSX from
scratch. Precompiling the JSX at build time would remove that file and the transform
entirely. That is a real change to how this project builds, deliberately not made while
fixing an outage.
