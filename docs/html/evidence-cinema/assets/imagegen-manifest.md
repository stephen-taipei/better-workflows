# Evidence Replay Cinema image generation manifest

Generated on 2026-08-24 with the built-in image generation tool. No CLI/API
fallback or transparent-background mode was used.

## Shared art direction

- Use case: illustration-story
- Asset type: cinematic scene illustrations and character art for an
  interactive evidence-replay webpage.
- Style: original polished 2D animated feature-film illustration, hand-painted
  gouache texture, soft ink contours, expressive silhouettes, sophisticated
  rather than babyish.
- Palette: cobalt blue, deep indigo, coral, amber, teal, pale lavender, and
  parchment cream.
- Constraints: preserve the six recurring character designs, no existing
  franchise style, no photorealism, no 3D render, no readable text, no logos,
  no watermark, no speech bubbles, and no split panels.

## Character anchor prompt

Create exactly six separated full-body characters on a warm parchment studio
backdrop:

1. Captain Root — cobalt-blue fox, short navy conductor coat, brass baton.
2. Scout Pixel — coral-red squirrel courier, parchment evidence satchel.
3. Ledger — deep-indigo river otter archivist, bound event log.
4. Vera — pale-lavender owl verifier, round brass magnifying spectacles.
5. Sentinel — amber tortoise gatekeeper, shield-shaped shoulder guard.
6. Echo — teal compact robot reconciler, one projector lens and receipt spool.

The result is cast-lineup.webp. The six character-*.webp files are
project-local crops of this same anchor so every role card preserves the exact
generated identity.

## Scene prompt set

Every scene used cast-lineup as the character and style reference.

1. scene-01-goal.webp — the whole cast opens a magical paper-and-brass archive
   cinema; Captain Root raises the baton and a blank glowing film path leads to
   a destination lantern.
2. scene-02-binding.webp — Captain Root and Sentinel lower a crystal cover over
   a branching source blueprint while a brass camera captures the exact
   arrangement.
3. scene-03-evidence.webp — Scout Pixel collects a bounded set of evidence cards
   from exact archive drawers; cards visually carry seals, timestamps, source
   chains, and fingerprints.
4. scene-04-verifier.webp — Vera works in a separate booth, comparing a clean
   blue film strip with coral counter-evidence that exposes a cracked frame and
   mismatched fingerprint.
5. scene-05-ledger.webp — Ledger operates a brass film-editing reducer: ordered
   event frames enter from the left and a ready/waiting/completed stage map is
   derived on the right; earlier frames are never rewritten.
6. scene-06-review.webp — an immutable film package receives one bounded local
   repair under Vera's inspection; five finite repair tickets and a separate
   broad-review lens remain visible.
7. scene-07-gate.webp — Sentinel keeps a drawbridge raised while Captain Root
   presents exactly one token and Echo waits with one closed canister; no one
   crosses before authority checks.
8. scene-08-reconcile.webp — Echo aligns a returned receipt with a distant
   provider beacon; source, evidence, ledger, review, and receipt illuminate the
   completion vault together while a coral blocked signal stays separate.

All scene prompts requested a wide 16:9 composition and quiet caption space.

## Local post-processing

- Generated PNGs were copied into the task worktree, converted with cwebp at
  quality 84 and method 6, and then removed from the worktree.
- Built-in originals remain under the thread-owned Codex generated-images
  directory; project references use only the optimized WebP files here.
- Character cards were cropped from the anchor with ImageMagick and exported at
  420 × 630 WebP.
- Final project assets: 1 lineup, 6 character cards, and 8 film scenes.
