---
sources: Foundry v14 Levels (visibility between levels), boot.js level visibility read live (14dafe50), guide page learn-floors
---
You moved down to the basement, but the ground floor is still drawn on top of it.

### Why it happens

In Foundry, each floor (a **Level**) has a list of the other floors that can be seen from it. Map Shine follows that list. If the basement's list includes the ground floor, and the ground floor art has no holes in it, the ground floor covers the basement.

### The fix

1. Open the scene's **Levels** settings.
2. Open the floor you are standing on, here the basement.
3. In its list of floors that can be seen, remove the floors **above** it.
4. Keep floors below if you want to see down through gaps, like a balcony over a hall.

> [!tip] A floor above should only be seen from below when its art has transparent holes: a broken roof, a balcony, a stairwell.

### Still wrong?

Switch floors once and back again. Floors can take a few seconds to load the first time. Map Shine shows the new floor only once it is ready.

[More about floors and levels](page:learn-floors).
