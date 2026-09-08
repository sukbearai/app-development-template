# Vendored anti-slop

Source: https://github.com/dmmulroy/anti-slop

Revision: `e8c4880471b23ab7f216fba7b27d173a6ef07d4c`

`src/` is the complete, unmodified upstream source, including rule tests and the optional Effect plugin. `LICENSE` is the upstream MIT license. Runtime dependencies are pinned in the root manifest. This repository enables every generic rule; the Effect group is available but disabled because the application does not depend on Effect.

Run `pnpm test:anti-slop` after dependency or vendor updates. Review upstream source changes, replace the source and license together, update this revision, and run the quality gates before accepting an update. Keep this vendor tree out of application tsconfigs and the application lint scan.
