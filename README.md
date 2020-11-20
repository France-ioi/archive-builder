# Quick Start

Copy `.env.dist` into `.env` and define the variables.

SECRET should be a random value, for example generated with:

```javascript
node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'
```

Build and run with:

    yarn install
    yarn start

To generate a zip file, navigate the user to path /?t=_TOKEN_, where
_TOKEN_ is a JsonWebToken signed with the value of SECRET and containing
a `manifestUrl` property.

The service will redirect to an HTML page that auto-refreshes.

When the zip is ready, a download link will appear.

## Manifests

A manifest is JSON data describing the contents to include in an archive.

The following manifest describes an archive incorporating the contents
of `shared.zip` plus `index.html` and `data.json`.

```json
{
  "version":"1.0.0",
  "contents": [
    {
      "from": {"url": "https://task.dev/shared.zip"},
      "to": {"unzip": ""}
    },
    {
      "from": {"url": "https://task.dev/offline_index?id=1"},
      "to": {"file": "index.html"}
    },
    {
      "from": {"string": "{}"},
      "to": {"file": "data.json"}
    }
  ]
}
```
