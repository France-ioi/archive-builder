# Quick Start

These variables must be defined in `.env` at the project root:

    PORT
    S3_ACCESS_KEY_ID
    S3_SECRET_ACCESS_KEY
    S3_REGION
    S3_BUCKET

Build and run with:

    yarn install
    npm start

To generate a zip file, send a GET /?task=_TASK\_URL_ request to the
webservice.  _TASK_URL_ should respond with JSON data describing the
contents of the archive.

Example:

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

This description will produce an archive incorporating the contents of
`shared.zip` plus `index.html` and `data.json`.

