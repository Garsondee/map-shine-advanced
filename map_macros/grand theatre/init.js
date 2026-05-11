// File: mythica-machina-grand-theatre/scripts/init.js

console.log("Mythica Machina - Grand Theatre | Initializing Script...");

// --- Constants ---
const FLAG_SCOPE = "curtainControl";
const FLAG_ID = "id";
const FLAG_STATE = "state";

// --- Helper Function: Local Video Synchronization ---
// Attempts to set the video's currentTime and ensures playback if appropriate.
// Runs on each client receiving a relevant tile update via the hook.
async function syncLocalVideo(tileId, context, targetTimestamp = 0) {
    const LOG_PREFIX_LOCAL = `Curtain Control Hook | [${game.user.isGM ? 'GM' : 'Player'}] Local Sync |`;
    const tile = canvas.tiles?.get(tileId); // Get the Tile *Object* from the canvas layer

    if (!tile?.texture?.baseTexture?.resource?.source) {
        // Tile might not be rendered yet or doesn't have a video source
        // console.log(`${LOG_PREFIX_LOCAL} (${context}) Tile ${tileId}: No video element found or tile not on canvas.`);
        return;
    }

    const videoElement = tile.texture.baseTexture.resource.source;

    if (!(videoElement instanceof HTMLVideoElement)) {
         // console.log(`${LOG_PREFIX_LOCAL} (${context}) Tile ${tileId}: Source is not an HTMLVideoElement.`);
         return; // Source isn't a video
    }

    // Log current state before attempting changes
    // console.log(`${LOG_PREFIX_LOCAL} (${context}) Tile ${tileId}: ReadyState=${videoElement.readyState}, Paused=${videoElement.paused}, CurrentTime=${videoElement.currentTime.toFixed(3)}, TargetTime=${targetTimestamp.toFixed(3)}`);

    // Wait for sufficient ready state (>= HAVE_CURRENT_DATA)
    // Avoids errors if metadata isn't loaded yet. Still might not be enough to play.
    if (videoElement.readyState >= 2) { // HAVE_CURRENT_DATA or higher
         try {
            // --- Set Timestamp ---
            const timeDifference = Math.abs(videoElement.currentTime - targetTimestamp);
            // Set time if it's significantly different OR if the target is exactly 0 and current isn't
            // Tolerance helps avoid seeking tiny amounts if browser/network jitter occurs
            const tolerance = 0.15; // Seconds
            if (timeDifference > tolerance || (targetTimestamp === 0 && videoElement.currentTime !== 0)) {
               console.log(`${LOG_PREFIX_LOCAL} (${context}) Tile ${tileId}: Setting currentTime = ${targetTimestamp.toFixed(3)} (was ${videoElement.currentTime.toFixed(3)}).`);
               videoElement.currentTime = targetTimestamp;
               // Note: Setting currentTime might momentarily pause the video in some browsers,
               // so we always check playback state afterwards.
            } else {
                 // console.log(`${LOG_PREFIX_LOCAL} (${context}) Tile ${tileId}: CurrentTime is close enough to target.`);
            }

            // --- Ensure Playback (if intended) ---
            // Check the TILE DOCUMENT's autoplay state, not just the element's paused state,
            // as the element might be paused due to browser policy even if autoplay is true.
            const shouldBePlaying = tile.document.video?.autoplay === true && !tile.document.hidden;

            if (shouldBePlaying && videoElement.paused) {
                 console.log(`${LOG_PREFIX_LOCAL} (${context}) Tile ${tileId}: Tile should be playing but element is paused. Attempting play...`);
                 // Play returns a promise, handle potential browser restrictions (e.g., requires user interaction)
                 await videoElement.play().catch(e => {
                     console.warn(`${LOG_PREFIX_LOCAL} (${context}) Tile ${tileId}: Playback failed. May require user interaction or browser setting change. Error: ${e.message}`);
                 });
                 // Log state *after* attempting play
                 // console.log(`${LOG_PREFIX_LOCAL} (${context}) Tile ${tileId}: Play attempted. Paused=${videoElement.paused}`);
            } else if (!shouldBePlaying && !videoElement.paused) {
                 console.log(`${LOG_PREFIX_LOCAL} (${context}) Tile ${tileId}: Tile should NOT be playing but element is playing. Pausing.`);
                 videoElement.pause();
            } else {
                // Either already playing as intended, or shouldn't be playing and is paused.
                // console.log(`${LOG_PREFIX_LOCAL} (${context}) Tile ${tileId}: Playback state matches intended state (ShouldPlay=${shouldBePlaying}, Paused=${videoElement.paused}).`);
            }

        } catch (err) {
            console.warn(`${LOG_PREFIX_LOCAL} (${context}) Tile ${tileId}: Error during video sync:`, err);
        }
    } else {
        console.warn(`${LOG_PREFIX_LOCAL} (${context}) Tile ${tileId}: Video not ready for sync (readyState: ${videoElement.readyState}). Cannot set time or ensure playback reliably yet.`);
        // Optional: Could implement a brief retry mechanism here if readyState is 1 (HAVE_METADATA)
        // Be cautious as this can add complexity.
        // if (videoElement.readyState === 1) {
        //    setTimeout(() => syncLocalVideo(tileId, context + " Retry", targetTimestamp), 100);
        // }
    }
}


// --- Hooks Registration ---
Hooks.once('ready', () => {
    const LOG_PREFIX_INIT = `Curtain Control Hook | [${game.user.isGM ? 'GM' : 'Player'}] Init |`;
    console.log(`${LOG_PREFIX_INIT} Hook registration running.`);

    // --- HOOK: updateTile ---
    // This hook runs on ALL clients AFTER a tile document has been updated locally.
    // It's the primary mechanism for clients to react to GM-initiated changes.
    // Arguments: (tileDocument, updateData, options, userId)
    Hooks.on('updateTile', (tileDocument, updateData, options, userId) => {
        const LOG_PREFIX_HOOK = `Curtain Control Hook | [${game.user.isGM ? 'GM' : 'Player'}] Update |`;

        // 1. Filter: Only care about our managed curtain tiles
        const curtainId = tileDocument.flags?.[FLAG_SCOPE]?.[FLAG_ID];
        const curtainState = tileDocument.flags?.[FLAG_SCOPE]?.[FLAG_STATE];
        if (!curtainId) {
            return; // Not a curtain tile we manage
        }

        // 2. Determine if this update warrants a local video sync
        const isNowVisible = !tileDocument.hidden;
        const shouldAutoplay = tileDocument.video?.autoplay === true;
        const targetTimestamp = tileDocument.video?.timestamp ?? 0; // Use timestamp from data, default 0

        // Check if the update data *specifically changed* relevant properties.
        // This helps prevent unnecessary sync attempts on unrelated updates (e.g., position drag).
        const changedVisibility = updateData.hasOwnProperty('hidden');
        const changedAutoplay = updateData.video?.hasOwnProperty('autoplay');
        const changedTimestamp = updateData.video?.hasOwnProperty('timestamp');

        // Trigger conditions:
        // - It became visible AND should autoplay (e.g., revealing 'opening' or 'closing')
        // - Autoplay was turned ON while it was visible (less common for curtains, but possible)
        // - Timestamp was explicitly set while it's visible and should autoplay (for potential future sync logic)
        // - Autoplay was turned OFF (to ensure pause)
        const needsSync =
             (changedVisibility && isNowVisible && shouldAutoplay) || // Just revealed & should play
             (changedAutoplay && shouldAutoplay && isNowVisible) ||   // Autoplay turned on while visible
             (changedTimestamp && isNowVisible && shouldAutoplay) ||  // Timestamp changed while visible/playing
             (changedAutoplay && !shouldAutoplay);                   // Autoplay turned OFF

        if (needsSync) {
            const reason = changedVisibility ? 'Visibility Changed' : (changedAutoplay ? 'Autoplay Changed' : 'Timestamp Changed');
            console.log(`${LOG_PREFIX_HOOK} Tile ${tileDocument.id} (Curtain ${curtainId}, State ${curtainState}): Triggering sync due to '${reason}'. Target Time: ${targetTimestamp.toFixed(3)}, Visible: ${isNowVisible}, Autoplay: ${shouldAutoplay}`);

            // Call the local sync function. No need for setTimeout(0) usually.
            // If timing issues arise where the video element isn't ready immediately after the update,
            // a small setTimeout *could* be reintroduced, but try without it first.
            syncLocalVideo(tileDocument.id, `Update Hook (${reason})`, targetTimestamp);

        } else {
             // Optional: Log why sync didn't trigger for curtain tiles (can be verbose)
             // if (curtainId) { // Only log for actual curtain tiles
             //    console.log(`${LOG_PREFIX_HOOK} Tile ${tileDocument.id}: No sync needed. Visible=${isNowVisible}, Autoplay=${shouldAutoplay}, ChangedVis=${changedVisibility}, ChangedAutoplay=${changedAutoplay}, ChangedTime=${changedTimestamp}`);
             // }
        }
    });

     console.log(`${LOG_PREFIX_INIT} updateTile hook registered successfully.`);

    // Optional: Consider adding a canvasReady hook for late joiners/refreshes?
    // This would require storing the animation start time in flags (more complex).
    // Hooks.on('canvasReady', () => { /* ... logic to find active animations and sync ... */ });

});

console.log("Mythica Machina - Grand Theatre | Script Initialized.");