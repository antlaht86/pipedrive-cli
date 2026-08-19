# 03 — No licence file, and the package is marked private

**Blocked by:** None — can start immediately.

**Status:** done

## What happens

The repository has no `LICENSE` file and the package manifest carries `"private": true` with no
`license` field. A public repository without a licence grants no rights at all — readers may look
but may not use, modify or redistribute, which is almost certainly not the intent of publishing.

## What I expected

A public repository states its licence in a file at the root and in the package manifest, and the
`private` flag reflects whether publishing to a registry is intended.

## Steps to reproduce

1. `ls LICENSE` — no such file.
2. Read `package.json` — `"private": true`, no `"license"` key.

## Additional context

Licence choice is a human decision, not an agent one. The `private` flag is separate from repository
visibility: it blocks an accidental registry publish and may deliberately stay `true` even for a
public repository, since the distribution record says build-from-source is the only channel.

## Comments

**2026-08-19 — the goal is a clonable repository.** A licence is now mandatory rather than tidy: the
reporter wants other people to clone, build and run `pd`, and without a licence file they have no
right to do any of it. The `private` flag in the manifest may stay `true`, because build-from-source
remains the only channel and the flag only blocks an accidental registry publish.

**2026-08-19 — done.** `LICENSE` holds the MIT text, copyright 2026 Antti Lahtinen. `package.json`
gains `"license": "MIT"` and keeps `"private": true`, because build-from-source stays the only
channel and the flag only blocks an accidental registry publish.
