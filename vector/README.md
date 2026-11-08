# vector/

Qdrant setup and health scripts (Person B). The library they use lives in
`app/src/lib/vector/` so the Next.js app and the worker share one copy and one
`node_modules`.

```
cd app
npm run vector:setup                 # create/validate collection tracex_records (384-d, cosine) + payload indexes
npm run vector:health                # Qdrant + collection check
npm run vector:health -- --embedding # also load the model (first run downloads ~130 MB)
npm run test:vector                  # unit tests (no services needed)
npm run test:vector:live             # needs Qdrant running; uses a throwaway collection
```

Start Qdrant locally (Docker): `docker run -p 6333:6333 -v qdrant_storage:/qdrant/storage qdrant/qdrant`

## Install notes

- `npm ci` / `npm install` works as-is on Windows and macOS.
- On **Linux x64** the `onnxruntime-node` package tries to download an optional GPU (CUDA) build
  from nuget.org during install. If that host is blocked, install with
  `ONNXRUNTIME_NODE_INSTALL=skip npm ci` (the CPU runtime ships inside the package; this project uses the CPU).
