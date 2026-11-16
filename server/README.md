# Hosted service moved

The hosted API and web UI now live in [web/](../web/README.md), using Next.js serverless functions on Vercel, R2, and Loops. The Go process in [engine/](../engine/) is exclusively the local desktop engine.

An ignored `server/.env` may remain on existing developer machines for private deployment credentials. New installations should use `web/.env.local`.
