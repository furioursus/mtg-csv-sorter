# @furioursus/ui (vendored)

`tokens.css` and `theme.js` are unmodified copies of
[`@furioursus/ui`](https://github.com/furioursus/furioursus-ui) **v0.1.0**, the colours, fonts and
light/dark switcher shared with furioursus.dev. They're copied in rather than linked from a CDN so
`index.html` keeps working opened from disk with no network.

Don't edit them here. Change the package, release it, then update the copies:

```sh
v=v0.1.0   # the new tag
for f in tokens.css theme.js; do
  curl -sfo "vendor/furioursus-ui/$f" "https://cdn.jsdelivr.net/gh/furioursus/furioursus-ui@$v/dist/$f"
done
npm test   # fails if the page uses a variable the new tokens no longer define
```

Then update the version above. Token names and the old → new map are in the package's
[`docs/tokens.md`](https://github.com/furioursus/furioursus-ui/blob/main/docs/tokens.md).
