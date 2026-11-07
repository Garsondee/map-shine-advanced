# The Map Shine Guide — how it is built and kept true

The guide opens from the Remote's **Help** button (`src/ui/rooms/remote/shell.js` →
`src/ui/rooms/guide/guide-room.js`). Two halves: **Quick Fixes** (problems mid-session,
with buttons that change the scene and can be undone) and **Learn** (making masks and
getting the best from every effect).

| Path | What |
| --- | --- |
| `guide.json` | The page list: id, half, section, title, icon, summary, optional thumbnail. |
| `pages/<id>.md` | One page each. Front matter `sources:` names the code it describes. |
| `images/*.webp` | Every picture. Generated, never hand-edited. |
| `shots.json` | How each picture is made: map, floor, spot, time, weather, annotations. |
| `src/ui/rooms/guide/` | The room, the Markdown renderer, the buttons (`guide-actions.js`), the live mask table (`guide-masks.js`). |
| `tools/guide/shoot.mjs`, `crop.py` | Re-render pictures on a private rig, then crop, annotate and write WebP. |

## Page syntax (beyond plain Markdown)

`[[do: id, id]]` buttons (ids in `GUIDE_ACTIONS`) · `[[cards: page, page]]` tiles ·
`[[looks]]` and `[[masks-table]]` live blocks · `::: compare "caption"` two images, a slider ·
`::: gallery` side by side · `> [!tip]`, `[!warn]`, `[!note]`, `[!try]` callouts ·
links `page:<id>` or `page:<id>#anchor`.

## The rules (keep it short, keep it true)

1. **Any change to a mask, an effect's behaviour, a default, or a control's name or place
   updates the guide in the same commit.** Find the pages by searching `sources:` lines.
2. **Concise.** One topic per page, under 650 words (the drift test enforces it). Prefer
   editing a sentence to adding one.
3. **Generated beats hand-written.** The mask table is built live from `MASK_KINDS`; button
   labels and "find it later" places come from the code. Only advice is prose.
4. **Never describe a planned feature as working.** Check `status: 'planned'` and the mask
   catalog before writing.
5. **Verify on the rig before writing a claim you are unsure of**, then name its source.
6. **Pictures are real renders of Mythica Machina maps**, named in every caption, at most
   1600 px wide. Re-shoot with `node tools/guide/shoot.mjs --name <client> --only <id>` then
   `python tools/guide/crop.py --data <rig Data dir> --only <id>`. Never on the live server.

`src/ui/__tests__/guide.test.mjs` fails the build when a page links to a missing page,
names a missing button, image or mask ending, loses its `sources:` line, runs over its word
budget, or when the images grow past their size budget.
