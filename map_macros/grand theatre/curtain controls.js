/*
Macro to INITIATE stage curtain transitions on the current scene in Foundry VTT.
Handles both tile animations (via module hook) and associated wall visibility.

Functionality:
- Identifies curtain tiles via FLAGS (for state/animation).
- Identifies associated walls via HARDCODED COORDINATES.
- Determines current state (closed/open) from tiles.
- Calculates necessary tile updates (show/hide, autoplay flags, TIMESTAMP).
- Calculates necessary wall updates using CONST.WALL_SENSE_TYPES.
- Sends updates via updateEmbeddedDocuments.
- Schedules delayed actions (tile hiding/revealing, wall updates) via setTimeout (GM only).

WARNING: Wall identification relies on exact coordinates and will break if walls are moved/adjusted.
Ensure the coordinates and constants (especially durations and wall types) are correct for your setup.
*/

(async () => {
    // ==================================================
    // =============== CONFIGURATION AREA ===============
    // ==================================================

    // --- Video Durations (in Milliseconds) ---
    // IMPORTANT: Set these to the actual durations of your video files!
    const OPENING_DURATION_MS = 10000; // Duration of the opening animation video
    const CLOSING_DURATION_MS = 12100; // Duration of the closing animation video

    // --- Timing Delays (in Milliseconds) ---
    const OVERLAP_DELAY_MS = 150;      // Delay before hiding the previous state's tile during transition.
    const PRE_REVEAL_DELAY_MS = 75;    // Delay before revealing the 'closing' tile (after prepping it hidden).

    // --- Tile Identification ---
    // This ID must match the flag value set on your curtain tiles.
    const CURTAIN_ID_FOR_TILES = 'curtain_7500_150_3150_1650';
    const FLAG_SCOPE = "curtainControl"; // Scope for the flags on the Tile documents
    const FLAG_ID = "id";               // Flag key holding the CURTAIN_ID_FOR_TILES
    const FLAG_STATE = "state";         // Flag key holding the tile's state ("closed", "opening", "closing")

    // --- Wall Identification ---
    // !! CRITICAL !! These coordinates MUST exactly match the wall segments you want to control.
    // Format: [[x1, y1], [x2, y2], [x3, y3], ...] defining the vertices of the curtain line.
    const HARDCODED_VERTICES = [
        [7697, 3469], [7734, 3628], [7816, 3772], [7971, 3892], [8168, 3976],
        [8421, 4041], [8796, 4094], [9075, 4119], [9350, 4103], [9678, 4062],
        [9963, 3982], [10183, 3871], [10315, 3764], [10405, 3635], [10460, 3470]
    ];
    const COORDINATE_MATCH_TOLERANCE = 1.0; // Increased tolerance slightly for floating point variations. Adjust if needed.

    // --- Wall Property Values (Foundry VTT v11/v12+) ---
    // *** CORRECTED based on console inspection ***
    // Uses constants found via console inspection (CONST.WALL_SENSE_TYPES).
    // Check F12 console `CONST.WALL_SENSE_TYPES` if issues persist in future versions.
    const WALL_BLOCKING_NONE = CONST.WALL_SENSE_TYPES.NONE;     // Value: 0 (Allows sight/light - Transparent)
    const WALL_BLOCKING_NORMAL = CONST.WALL_SENSE_TYPES.NORMAL; // Value: 20 (Blocks sight/light - Standard Wall)
    // Optional: If you ever need window-like walls:
    // const WALL_BLOCKING_LIMITED = CONST.WALL_SENSE_TYPES.LIMITED; // Value: 10

    // --- Module Dependency ---
    // Ensure the module providing the tile video synchronization hook is active.
    const REQUIRED_MODULE_ID = "mythica-machina-grand-theatre"; // Or the ID of your synchronization module

    // ==================================================
    // ============ END CONFIGURATION AREA ============
    // ==================================================

    // --- Logging Prefix (GM Only) ---
    const LOG_PREFIX = `Curtain Control (Coords) | [GM] |`;

    // --- Helper Functions ---
    /**
     * Checks if two points [x, y] are within a given tolerance.
     * @param {number[]} p1 - First point [x, y]
     * @param {number[]} p2 - Second point [x, y]
     * @param {number} tolerance - Maximum allowed distance between coordinates.
     * @returns {boolean} - True if points are considered equal.
     */
    function arePointsEqual(p1, p2, tolerance) {
        if (!p1 || !p2 || p1.length !== 2 || p2.length !== 2) return false;
        return Math.abs(p1[0] - p2[0]) < tolerance && Math.abs(p1[1] - p2[1]) < tolerance;
    }

    /**
     * Generates wall segment coordinates [x1, y1, x2, y2] from a list of vertices.
     * @param {number[][]} vertices - Array of [x, y] points.
     * @returns {number[][]} - Array of [x1, y1, x2, y2] segments.
     */
    function getTargetWallSegments(vertices) {
        if (!Array.isArray(vertices)) {
            console.error(`${LOG_PREFIX} CRITICAL ERROR: HARDCODED_VERTICES is not an array!`, vertices);
            ui.notifications.error("Curtain Control: Internal error (VERTICES).");
            return [];
        }
        const segments = [];
        if (vertices.length < 2) {
            console.warn(`${LOG_PREFIX} HARDCODED_VERTICES has less than 2 points. Cannot form segments.`);
            return segments;
        }
        for (let i = 0; i < vertices.length - 1; i++) {
             if (!Array.isArray(vertices[i]) || vertices[i].length !== 2 || !Array.isArray(vertices[i+1]) || vertices[i+1].length !== 2) {
                 console.error(`${LOG_PREFIX} Invalid vertex format at index ${i} or ${i+1} in HARDCODED_VERTICES. Skipping segment.`);
                 continue;
             }
            segments.push([...vertices[i], ...vertices[i + 1]]);
        }
        return segments;
    }

    /**
     * Finds wall documents matching the provided segment coordinates.
     * @param {Scene} scene - The scene to search within.
     * @param {number[][]} targetSegments - Array of [x1, y1, x2, y2] segments to match.
     * @param {number} tolerance - Tolerance for coordinate matching.
     * @returns {string[]} - An array of matching Wall document IDs.
     */
    function findMatchingWallIds(scene, targetSegments, tolerance) {
        const foundIds = new Set(); // Use Set to avoid duplicates
        const allSceneWalls = scene?.walls; // Collection of WallDocuments

        if (!allSceneWalls || allSceneWalls.size === 0) {
            console.warn(`${LOG_PREFIX} No walls found in the scene to search.`);
            return [];
        }
        if (targetSegments.length === 0) {
             console.warn(`${LOG_PREFIX} No target wall segments provided to search for.`);
             return [];
        }

        console.log(`${LOG_PREFIX} Searching for ${targetSegments.length} wall segments among ${allSceneWalls.size} scene walls...`);

        for (const wallDoc of allSceneWalls.values()) {
            const wallCoords = wallDoc?.c; // Wall coordinates [x1, y1, x2, y2]
            if (!wallCoords || !Array.isArray(wallCoords) || wallCoords.length !== 4 || wallCoords.some(coord => typeof coord !== 'number')) {
                 // console.warn(`${LOG_PREFIX} Skipping wall ${wallDoc.id} due to invalid coordinates.`);
                 continue;
            }
            const p1 = [wallCoords[0], wallCoords[1]];
            const p2 = [wallCoords[2], wallCoords[3]];

            for (const targetSegment of targetSegments) {
                if (!targetSegment || !Array.isArray(targetSegment) || targetSegment.length !== 4 || targetSegment.some(coord => typeof coord !== 'number')) {
                     console.error(`${LOG_PREFIX} Invalid target segment format encountered during search. Skipping.`);
                     continue; // Skip invalid target segment
                }
                const tp1 = [targetSegment[0], targetSegment[1]];
                const tp2 = [targetSegment[2], targetSegment[3]];

                let match = false;
                try {
                    // Check both forward and reverse segment direction
                    const matchForward = arePointsEqual(p1, tp1, tolerance) && arePointsEqual(p2, tp2, tolerance);
                    const matchReverse = arePointsEqual(p1, tp2, tolerance) && arePointsEqual(p2, tp1, tolerance);
                    match = matchForward || matchReverse;
                } catch (e) {
                    console.error(`${LOG_PREFIX} Error during point comparison for wall ${wallDoc.id}:`, e);
                }

                if (match) {
                    foundIds.add(wallDoc.id);
                    // Optimization: Once a wall matches a target segment, no need to check it against others
                    break;
                }
            }
        }
        const finalIds = Array.from(foundIds);
         if (finalIds.length > 0) {
            console.log(`${LOG_PREFIX} Wall Search Result: Found ${finalIds.length} associated walls matching coordinates. Wall IDs: [${finalIds.join(', ')}]`);
            if (finalIds.length !== targetSegments.length) {
                console.warn(`${LOG_PREFIX} WARNING: Found ${finalIds.length} unique walls, but expected ${targetSegments.length} segments based on vertices. This might be okay if vertices form connected segments, but check coordinates if walls seem missing.`);
            }
        } else {
             console.warn(`${LOG_PREFIX} WARNING: Wall Search Result: No walls found matching the hardcoded coordinates. Wall control will be skipped.`);
        }
        return finalIds;
    }

    /**
     * Logs the current sight and light properties of specified walls for debugging.
     * @param {string[]} wallIds - Array of wall IDs to check.
     * @param {string} context - String describing when/why the check is happening.
     */
    async function logWallStatesAfterUpdate(wallIds, context) {
        // Short delay to allow the database update to potentially propagate
        await new Promise(resolve => setTimeout(resolve, 100));
        console.log(`${LOG_PREFIX} [${context}] Checking wall states AFTER update attempt for IDs: [${wallIds.join(', ')}]`);
        if (!canvas?.scene?.walls) {
            console.log(`  > Cannot check walls, scene or walls layer not available.`);
            return;
        }
        for (const id of wallIds) {
            const wallDoc = canvas.scene.walls.get(id); // Get WallDocument directly
            if (wallDoc) {
                console.log(`  > Wall ${id}: sight = ${wallDoc.sight}, light = ${wallDoc.light}`);
            } else {
                console.log(`  > Wall ${id}: Document not found in current scene after update attempt.`);
            }
        }
    }

    // --- Main Execution Logic ---
    console.log(`${LOG_PREFIX} Macro Execution Started.`);

    // 1. Permissions and Scene Check
    if (!game.user.isGM) {
        ui.notifications.warn("Curtain Control: This macro can only be run by the GM.");
        console.warn(`${LOG_PREFIX} Non-GM user attempted to run the macro.`);
        return;
    }
    if (!canvas?.scene) {
        ui.notifications.warn("Curtain Control: No active scene found.");
        console.warn(`${LOG_PREFIX} No active scene found.`);
        return;
    }
    const currentScene = canvas.scene;

    // 2. Module Dependency Check
    if (!game.modules.get(REQUIRED_MODULE_ID)?.active) {
         ui.notifications.error(`Curtain Control: The '${REQUIRED_MODULE_ID}' module must be active for tile synchronization.`);
         console.error(`${LOG_PREFIX} Required module '${REQUIRED_MODULE_ID}' is not active.`);
         return;
    } else {
        console.log(`${LOG_PREFIX} Verified '${REQUIRED_MODULE_ID}' module is active.`);
    }

    // 3. Verify HARDCODED_VERTICES Configuration
    if (typeof HARDCODED_VERTICES === 'undefined' || !Array.isArray(HARDCODED_VERTICES) || HARDCODED_VERTICES.length < 2) {
        console.error(`${LOG_PREFIX} CRITICAL ERROR: The 'HARDCODED_VERTICES' constant in the macro is missing, not an array, or has too few points (< 2). Please check the macro configuration.`);
        ui.notifications.error("Curtain Control: Macro configuration error (HARDCODED_VERTICES). Check console (F12).");
        return;
    }
    console.log(`${LOG_PREFIX} HARDCODED_VERTICES verified. Vertex count: ${HARDCODED_VERTICES.length}.`);

    // 4. Identify Managed Tiles on Current Scene
    const currentManagedTiles = currentScene.tiles.filter(t => t.flags?.[FLAG_SCOPE]?.[FLAG_ID] === CURTAIN_ID_FOR_TILES);
    if (currentManagedTiles.length === 0) {
        ui.notifications.warn(`Curtain Control: No managed curtain tiles found with flag ID '${CURTAIN_ID_FOR_TILES}'. Ensure tile flags are set correctly (${FLAG_SCOPE}.${FLAG_ID}).`);
        console.warn(`${LOG_PREFIX} No managed curtain tiles found on the scene with ID '${CURTAIN_ID_FOR_TILES}'.`);
        return;
    }
    console.log(`${LOG_PREFIX} Found ${currentManagedTiles.length} managed tiles with ID '${CURTAIN_ID_FOR_TILES}'.`);

    // 5. Identify Associated Walls using Coordinates
    const targetWallSegments = getTargetWallSegments(HARDCODED_VERTICES);
    const initialFoundWallIds = findMatchingWallIds(currentScene, targetWallSegments, COORDINATE_MATCH_TOLERANCE);
    // Note: We will re-find walls inside timeouts before updating them, in case the scene changes.

    // 6. Determine Current Curtain State (from visible tiles)
    const visibleTiles = currentManagedTiles.filter(t => !t.hidden);
    let currentState = "open"; // Default if no curtains are visible
    let visibleTileIdsToHide = [];

    if (visibleTiles.length > 0) {
        // Use the state from the first visible tile, warn if inconsistent
        currentState = visibleTiles[0].flags?.[FLAG_SCOPE]?.[FLAG_STATE] ?? "open"; // Fallback if state flag missing
        visibleTileIdsToHide = visibleTiles.map(t => t.id);

        const uniqueVisibleStates = new Set(visibleTiles.map(t => t.flags?.[FLAG_SCOPE]?.[FLAG_STATE]));
        if (uniqueVisibleStates.size > 1) {
            console.warn(`${LOG_PREFIX} Inconsistent visible tile states found: ${[...uniqueVisibleStates].join(', ')}. Using state from first visible tile: '${currentState}'.`);
        } else if (uniqueVisibleStates.size === 1 && !uniqueVisibleStates.has(undefined)) {
            console.log(`${LOG_PREFIX} Consistent visible tile state found: '${currentState}'.`);
        } else {
             // Handle cases with undefined state flags or only one tile without state
             console.log(`${LOG_PREFIX} Visible tile(s) found, but state flag missing or inconsistent. Assuming effective state based on first tile: '${currentState}'.`);
        }
    } else {
        console.log(`${LOG_PREFIX} No managed curtains currently visible. Assuming state is 'open'.`);
        currentState = "open";
    }

    // Treat "opening" state as functionally "open" for triggering the next action (closing)
    if (currentState === "opening") {
        console.log(`${LOG_PREFIX} Current state is 'opening', treating effective state as 'open' to trigger closing sequence.`);
        currentState = "open";
    }

    console.log(`${LOG_PREFIX} Effective current state for transition: '${currentState}'. Tiles to hide: ${visibleTileIdsToHide.join(', ') || 'None'}`);

    // 7. Determine Target State and Prepare Initial Updates
    let targetState = null;
    let wallsShouldBlock = false; // Target state for walls: True = block (NORMAL), False = allow (NONE)
    let scheduleFinalClosingReset = false; // Flag to trigger the closing->closed finalization

    if (currentState === "closed") {
        targetState = "opening";
        wallsShouldBlock = false; // Open curtains -> walls should NOT block (Use WALL_BLOCKING_NONE)
        ui.notifications.info("Curtain Control: Opening curtains...");
    } else { // Assumed "open" or interrupting "closing" -> transition to closing
        targetState = "closing";
        wallsShouldBlock = true; // Close curtains -> walls SHOULD block (Use WALL_BLOCKING_NORMAL)
        scheduleFinalClosingReset = true; // Need the final timeout to switch to static "closed" tile and update walls
        ui.notifications.info("Curtain Control: Closing curtains...");
    }
    console.log(`${LOG_PREFIX} Target tile state: '${targetState}'. Target wall state: block=${wallsShouldBlock}. Scheduling final closing reset: ${scheduleFinalClosingReset}.`);

    // Prepare updates to stop video playback on currently visible tiles (if any)
    const updatesToStopVideo = visibleTileIdsToHide.map(id => ({
        _id: id,
        "video.autoplay": false,
        "video.loop": false, // Ensure loop is off too
        "video.timestamp": 0 // Reset timestamp
    }));

    // Identify the tiles corresponding to the TARGET state (using flags)
    const targetTiles = currentManagedTiles.filter(t => t.flags?.[FLAG_SCOPE]?.[FLAG_STATE] === targetState);
    const targetTileIds = targetTiles.map(t => t.id);

    if (targetTiles.length === 0) {
        console.error(`${LOG_PREFIX} CRITICAL ERROR: Could not find any tiles flagged with the target state '${targetState}' and ID '${CURTAIN_ID_FOR_TILES}'. Cannot proceed.`);
        ui.notifications.error(`Curtain Control: Missing tiles for state '${targetState}'. Check tile flags.`);
        return;
    }
    console.log(`${LOG_PREFIX} Identified ${targetTiles.length} target tiles for state '${targetState}': [${targetTileIds.join(', ')}]`);

    // 8. Execute Transition (Main Update Logic)
    try {
        let initialCombinedTileUpdates = []; // Updates to send immediately

        // --- Schedule Hiding of Previous Tiles (GM Only Timeout) ---
        // This happens quickly after the transition starts.
         if (visibleTileIdsToHide.length > 0) {
            console.log(`${LOG_PREFIX} Scheduling HIDE for ${visibleTileIdsToHide.length} previous tiles in ${OVERLAP_DELAY_MS}ms.`);
            setTimeout(async () => {
                const currentSceneRef = canvas.scene; // Reference scene at time of timeout execution
                if (!currentSceneRef) {
                    console.error(`${LOG_PREFIX} [Timeout ${OVERLAP_DELAY_MS}ms] Scene vanished before hiding tiles.`);
                    return;
                }
                const currentSceneTileIds = new Set(currentSceneRef.tiles.map(t => t.id));
                const updatesToHide = visibleTileIdsToHide
                    .filter(id => currentSceneTileIds.has(id)) // Ensure tile still exists
                    .map(id => ({ _id: id, hidden: true, "video.autoplay": false, "video.timestamp": 0 }));

                if (updatesToHide.length > 0) {
                    console.log(`${LOG_PREFIX} [Timeout ${OVERLAP_DELAY_MS}ms] Executing hide for ${updatesToHide.length} previous tiles.`);
                    try {
                        await currentSceneRef.updateEmbeddedDocuments("Tile", updatesToHide);
                        console.log(`${LOG_PREFIX} [Timeout ${OVERLAP_DELAY_MS}ms] Hide previous tiles update successful.`);
                    } catch (hideErr) {
                         console.error(`${LOG_PREFIX} [Timeout ${OVERLAP_DELAY_MS}ms] Error hiding tiles:`, hideErr);
                    }
                } else {
                     console.log(`${LOG_PREFIX} [Timeout ${OVERLAP_DELAY_MS}ms] No valid previous tiles found to hide (they might have been deleted).`);
                }
                 // --- Wall update for OPENING happens LATER, after OPENING_DURATION_MS ---
            }, OVERLAP_DELAY_MS);
        }

        // --- Branching Logic for Initial Tile Update (Start the Animation) ---
        if (targetState === "closing") {
            // Stage 1: Prepare 'closing' tile (hidden, ready to play) and stop any old tiles.
            const updatesToPrepClosing = targetTileIds.map(id => ({
                _id: id,
                hidden: true, // Start hidden
                "video.timestamp": 0,
                "video.autoplay": true, // Will start playing when revealed
                "video.loop": false
            }));
            initialCombinedTileUpdates = [...updatesToPrepClosing, ...updatesToStopVideo];

            if (initialCombinedTileUpdates.length > 0) {
                console.log(`${LOG_PREFIX} Closing Stage 1: Sending ${initialCombinedTileUpdates.length} updates (prep hidden closing tiles, stop old tiles).`);
                await currentScene.updateEmbeddedDocuments("Tile", initialCombinedTileUpdates);
                console.log(`${LOG_PREFIX} Closing Stage 1: Initial prep/stop update complete.`);

                // Stage 2: Schedule Delayed Reveal of the 'closing' tile.
                if (targetTileIds.length > 0) {
                    console.log(`${LOG_PREFIX} Closing Stage 2: Scheduling REVEAL for ${targetTileIds.length} closing tiles in ${PRE_REVEAL_DELAY_MS}ms.`);
                    setTimeout(async () => {
                        const currentSceneRef = canvas.scene;
                         if (!currentSceneRef) {
                             console.error(`${LOG_PREFIX} [Timeout ${PRE_REVEAL_DELAY_MS}ms] Scene vanished before revealing closing tiles.`);
                             return;
                         }
                        const currentSceneTileIds = new Set(currentSceneRef.tiles.map(t => t.id));
                        const updatesToReveal = targetTileIds
                            .filter(id => currentSceneTileIds.has(id))
                            .map(id => ({ _id: id, hidden: false })); // Reveal the tile

                        if (updatesToReveal.length > 0) {
                             console.log(`${LOG_PREFIX} [Timeout ${PRE_REVEAL_DELAY_MS}ms] Executing reveal for ${updatesToReveal.length} closing tiles.`);
                            try {
                                await currentSceneRef.updateEmbeddedDocuments("Tile", updatesToReveal);
                                console.log(`${LOG_PREFIX} [Timeout ${PRE_REVEAL_DELAY_MS}ms] Successfully revealed closing tiles.`);
                            } catch(revealErr) {
                                console.error(`${LOG_PREFIX} [Timeout ${PRE_REVEAL_DELAY_MS}ms] Error revealing closing tiles:`, revealErr);
                            }
                        } else {
                            console.log(`${LOG_PREFIX} [Timeout ${PRE_REVEAL_DELAY_MS}ms] No valid closing tiles found to reveal.`);
                        }
                    }, PRE_REVEAL_DELAY_MS);
                }
            } else {
                console.log(`${LOG_PREFIX} Closing sequence: No initial prep/stop tile updates needed.`);
            }

        } else if (targetState === "opening") {
            // Stage 1: Show 'opening' tile and start playback, stop any old tiles.
            const updatesToShowOpening = targetTileIds.map(id => ({
                 _id: id,
                 hidden: false, // Show immediately
                 "video.timestamp": 0,
                 "video.autoplay": true,
                 "video.loop": false
            }));
            initialCombinedTileUpdates = [...updatesToShowOpening, ...updatesToStopVideo];

            if (initialCombinedTileUpdates.length > 0) {
                console.log(`${LOG_PREFIX} Opening Stage 1: Sending ${initialCombinedTileUpdates.length} updates (show opening tiles, stop old tiles).`);
                await currentScene.updateEmbeddedDocuments("Tile", initialCombinedTileUpdates);
                console.log(`${LOG_PREFIX} Opening Stage 1: Initial show/stop update complete.`);
            } else {
                console.log(`${LOG_PREFIX} Opening sequence: No initial show/stop tile updates needed.`);
            }
        }

        // --- Schedule the Final State Actions (Wall Updates & Tile Cleanup) ---

        if (targetState === "closing" && scheduleFinalClosingReset) {
             // *** SCHEDULE FINAL RESET (Closing -> Closed) + WALL UPDATE (BLOCK) ***
             // This happens after the closing animation finishes.
             console.log(`${LOG_PREFIX} Scheduling final reset to 'closed' state and WALL BLOCK update in ${CLOSING_DURATION_MS}ms.`);

            setTimeout(async () => {
                const finalResetTime = Date.now();
                console.log(`${LOG_PREFIX} [Timeout ${CLOSING_DURATION_MS}ms @ ${finalResetTime}] Final Closing Reset Timeout Reached.`);
                const sceneAtTimeout = canvas?.scene; // Get scene state at the moment of execution
                if (!sceneAtTimeout) {
                     console.error(`${LOG_PREFIX} [Timeout ${CLOSING_DURATION_MS}ms] Scene vanished before final closing reset.`);
                     return;
                }

                let tileUpdatesShowClosed = [];
                let tileUpdatesStopClosing = [];
                let closingTileIdsToClean = [];
                let needsTileServerUpdate = false;
                let needsWallServerUpdate = false;

                // Re-verify walls by COORDINATES right before updating
                const latestTargetSegments = getTargetWallSegments(HARDCODED_VERTICES);
                const latestFoundWallIds = findMatchingWallIds(sceneAtTimeout, latestTargetSegments, COORDINATE_MATCH_TOLERANCE);
                console.log(`${LOG_PREFIX} [Timeout ${CLOSING_DURATION_MS}ms] Re-verified walls: Found ${latestFoundWallIds.length}. Target IDs: [${latestFoundWallIds.join(', ')}]`);

                 // Get latest tile data specifically for THIS curtain ID within the current scene
                const latestManagedTiles = sceneAtTimeout.tiles.filter(t => t.flags?.[FLAG_SCOPE]?.[FLAG_ID] === CURTAIN_ID_FOR_TILES);
                const closedTile = latestManagedTiles.find(t => t.flags?.[FLAG_SCOPE]?.[FLAG_STATE] === "closed");
                const closingTile = latestManagedTiles.find(t => t.flags?.[FLAG_SCOPE]?.[FLAG_STATE] === "closing");

                // Determine Tile Updates Needed
                if (closedTile && closedTile.hidden) {
                    // Need to show the static 'closed' tile
                    needsTileServerUpdate = true;
                    tileUpdatesShowClosed.push({_id: closedTile.id, hidden: false, "video.autoplay": true, "video.loop": true, "video.timestamp": 0});
                    console.log(`${LOG_PREFIX} [Timeout ${CLOSING_DURATION_MS}ms] Planning to show 'closed' tile: ${closedTile.id}`);
                } else if (closedTile && !closedTile.hidden) {
                     console.log(`${LOG_PREFIX} [Timeout ${CLOSING_DURATION_MS}ms] 'Closed' tile (${closedTile.id}) is already visible.`);
                     // Ensure it's looping if it wasn't already marked for update
                     if (!tileUpdatesShowClosed.some(u => u._id === closedTile.id)) {
                         if (!closedTile.video.loop || !closedTile.video.autoplay) {
                             needsTileServerUpdate = true;
                              tileUpdatesShowClosed.push({_id: closedTile.id, "video.autoplay": true, "video.loop": true});
                              console.log(`${LOG_PREFIX} [Timeout ${CLOSING_DURATION_MS}ms] Planning to ensure 'closed' tile ${closedTile.id} is looping.`);
                         }
                     }
                } else if (!closedTile) {
                    console.warn(`${LOG_PREFIX} [Timeout ${CLOSING_DURATION_MS}ms] Could not find 'closed' state tile for ID ${CURTAIN_ID_FOR_TILES}. Cannot show final state.`);
                }

                if (closingTile && !closingTile.hidden) {
                    // Need to stop and eventually hide the 'closing' animation tile
                    needsTileServerUpdate = true;
                    closingTileIdsToClean.push(closingTile.id);
                    tileUpdatesStopClosing.push({_id: closingTile.id, "video.autoplay": false});
                    console.log(`${LOG_PREFIX} [Timeout ${CLOSING_DURATION_MS}ms] Planning to stop 'closing' tile: ${closingTile.id}`);
                } else if (closingTile && closingTile.hidden) {
                     console.log(`${LOG_PREFIX} [Timeout ${CLOSING_DURATION_MS}ms] 'Closing' tile (${closingTile.id}) is already hidden.`);
                } else if (!closingTile) {
                    // This is unusual but not necessarily an error if cleanup already happened.
                     console.log(`${LOG_PREFIX} [Timeout ${CLOSING_DURATION_MS}ms] Did not find a 'closing' state tile.`);
                }

                // Determine Wall Updates Needed (Make them BLOCK using WALL_BLOCKING_NORMAL)
                if (latestFoundWallIds.length > 0) {
                    const latestAssociatedWalls = latestFoundWallIds.map(id => sceneAtTimeout.walls.get(id)).filter(Boolean); // Get WallDocuments
                    // Check if *any* wall needs to be updated to blocking state
                    const wallsNeedBlocking = latestAssociatedWalls.some(w => w.sight !== WALL_BLOCKING_NORMAL || w.light !== WALL_BLOCKING_NORMAL);
                    if (wallsNeedBlocking) {
                        needsWallServerUpdate = true;
                        console.log(`${LOG_PREFIX} [Timeout ${CLOSING_DURATION_MS}ms] Wall update required (target: BLOCK - ${WALL_BLOCKING_NORMAL}).`);
                    } else {
                        console.log(`${LOG_PREFIX} [Timeout ${CLOSING_DURATION_MS}ms] Walls already appear to be in the target BLOCK state (${WALL_BLOCKING_NORMAL}).`);
                    }
                } else {
                    console.log(`${LOG_PREFIX} [Timeout ${CLOSING_DURATION_MS}ms] No walls found based on coordinates, skipping wall update.`);
                }

                // --- Execute Combined Updates for Closing Completion ---
                if (needsTileServerUpdate || needsWallServerUpdate) {
                    try {
                        // Stage A: Update Tiles (Show 'closed', Stop 'closing')
                        const resetInitialTileUpdates = [...tileUpdatesShowClosed, ...tileUpdatesStopClosing];
                        if (resetInitialTileUpdates.length > 0) {
                            console.log(`${LOG_PREFIX} [Timeout ${CLOSING_DURATION_MS}ms] Stage A: Sending ${resetInitialTileUpdates.length} tile updates (show closed, stop closing).`);
                            await sceneAtTimeout.updateEmbeddedDocuments("Tile", resetInitialTileUpdates);
                            console.log(`${LOG_PREFIX} [Timeout ${CLOSING_DURATION_MS}ms] Stage A: Tile update sent successfully.`);
                        }

                        // Stage B: Update Walls (Make them BLOCK)
                        if (needsWallServerUpdate && latestFoundWallIds.length > 0) {
                             console.log(`${LOG_PREFIX} [Timeout ${CLOSING_DURATION_MS}ms] Stage B: Updating ${latestFoundWallIds.length} walls to BLOCK (Sight: ${WALL_BLOCKING_NORMAL}, Light: ${WALL_BLOCKING_NORMAL}).`);
                             const wallUpdatesToBlock = latestFoundWallIds.map(id => ({
                                 _id: id,
                                 sight: WALL_BLOCKING_NORMAL, // Use the correct constant value
                                 light: WALL_BLOCKING_NORMAL  // Use the correct constant value
                                 // Add move/sound here if needed, check their CONST values too
                             }));
                             await sceneAtTimeout.updateEmbeddedDocuments("Wall", wallUpdatesToBlock);
                             console.log(`${LOG_PREFIX} [Timeout ${CLOSING_DURATION_MS}ms] Stage B: Wall update attempt (BLOCK) sent.`);
                             await logWallStatesAfterUpdate(latestFoundWallIds, `Timeout ${CLOSING_DURATION_MS}ms - Closing Complete`);
                             ui.notifications.info("Curtain Control: Curtains closed."); // Notify after wall update attempt
                        } else if (!needsWallServerUpdate && latestFoundWallIds.length > 0) {
                             console.log(`${LOG_PREFIX} [Timeout ${CLOSING_DURATION_MS}ms] Stage B: Wall update skipped (walls already blocking).`);
                             // If only tile updates happened, notify here. If no updates happened, notify in else block below.
                             if (needsTileServerUpdate) ui.notifications.info("Curtain Control: Curtains closed.");
                        } else if (latestFoundWallIds.length === 0){
                            // If no walls were found but tiles were updated
                             if (needsTileServerUpdate) ui.notifications.info("Curtain Control: Curtains closed (no walls found).");
                        }


                        // Stage C: Schedule Final Tile Cleanup (Hide 'closing' tile after a short delay)
                        if (closingTileIdsToClean.length > 0) {
                             console.log(`${LOG_PREFIX} [Timeout ${CLOSING_DURATION_MS}ms] Stage C: Scheduling final hide/reset for ${closingTileIdsToClean.length} closing tiles in ${OVERLAP_DELAY_MS}ms...`);
                            setTimeout(async () => {
                                const cleanupSceneRef = canvas?.scene;
                                if (!cleanupSceneRef) return;
                                const currentSceneTileIds = new Set(cleanupSceneRef.tiles.map(t => t.id));
                                const finalHideUpdates = closingTileIdsToClean
                                    .filter(id => currentSceneTileIds.has(id))
                                    .map(id => ({ _id: id, hidden: true, "video.autoplay": false, "video.timestamp": 0 }));
                                if (finalHideUpdates.length > 0) {
                                    console.log(`${LOG_PREFIX} [Timeout ${CLOSING_DURATION_MS}ms + ${OVERLAP_DELAY_MS}ms] Executing final hide/reset for 'closing' tiles.`);
                                    try {
                                        await cleanupSceneRef.updateEmbeddedDocuments("Tile", finalHideUpdates);
                                        console.log(`${LOG_PREFIX} [Timeout ${CLOSING_DURATION_MS}ms + ${OVERLAP_DELAY_MS}ms] Final cleanup update sent.`);
                                    } catch (finalHideErr) {
                                         console.error(`${LOG_PREFIX} [Timeout ${CLOSING_DURATION_MS}ms + ${OVERLAP_DELAY_MS}ms] Final cleanup error:`, finalHideErr);
                                    }
                                }
                            }, OVERLAP_DELAY_MS); // Use the short overlap delay for cleanup
                        }

                    } catch (resetErr) {
                        console.error(`${LOG_PREFIX} [Timeout ${CLOSING_DURATION_MS}ms] Error during final closing reset stages:`, resetErr);
                        ui.notifications.error("Curtain Control: Error finalizing closed state. Check console.");
                    }
                } else {
                    console.log(`${LOG_PREFIX} [Timeout ${CLOSING_DURATION_MS}ms] Final reset: No tile or wall server updates were deemed necessary.`);
                    // Check if notification is still needed (e.g., everything was already correct)
                    const closedTileIsVisible = latestManagedTiles.some(t => t.flags?.[FLAG_SCOPE]?.[FLAG_STATE] === 'closed' && !t.hidden);
                    let wallsAreBlocking = true; // Assume true if no walls found
                     if (latestFoundWallIds.length > 0) {
                         const latestAssociatedWalls = latestFoundWallIds.map(id => sceneAtTimeout.walls.get(id)).filter(Boolean);
                         wallsAreBlocking = latestAssociatedWalls.every(w => w.sight === WALL_BLOCKING_NORMAL && w.light === WALL_BLOCKING_NORMAL);
                     }
                     if(closedTileIsVisible && wallsAreBlocking) {
                           ui.notifications.info("Curtain Control: Curtains confirmed closed.");
                     }
                }
            }, CLOSING_DURATION_MS); // End of closing timeout

        } else if (targetState === "opening") {
            // *** SCHEDULE WALL UPDATE (ALLOW) FOR OPENING COMPLETION ***
            // This happens after the opening animation finishes.
            console.log(`${LOG_PREFIX} Scheduling WALL ALLOW update after opening animation in ${OPENING_DURATION_MS}ms.`);
             setTimeout(async () => {
                const openingCompleteTime = Date.now();
                console.log(`${LOG_PREFIX} [Timeout ${OPENING_DURATION_MS}ms @ ${openingCompleteTime}] Opening Completion Timeout Reached.`);
                const sceneAtTimeout = canvas?.scene;
                 if (!sceneAtTimeout) {
                     console.error(`${LOG_PREFIX} [Timeout ${OPENING_DURATION_MS}ms] Scene vanished before opening wall update.`);
                     return;
                 }

                // Re-find walls by COORDINATES just before update
                const latestTargetSegments = getTargetWallSegments(HARDCODED_VERTICES);
                const latestFoundWallIds = findMatchingWallIds(sceneAtTimeout, latestTargetSegments, COORDINATE_MATCH_TOLERANCE);
                console.log(`${LOG_PREFIX} [Timeout ${OPENING_DURATION_MS}ms] Re-verified walls for opening completion: Found ${latestFoundWallIds.length}. Target IDs: [${latestFoundWallIds.join(', ')}]`);

                 if (latestFoundWallIds.length > 0) {
                    // Check if walls actually *need* the update
                    const latestAssociatedWalls = latestFoundWallIds.map(id => sceneAtTimeout.walls.get(id)).filter(Boolean);
                    const wallsNeedAllowing = latestAssociatedWalls.some(w => w.sight !== WALL_BLOCKING_NONE || w.light !== WALL_BLOCKING_NONE);

                    if (wallsNeedAllowing) {
                        console.log(`${LOG_PREFIX} [Timeout ${OPENING_DURATION_MS}ms] Updating ${latestFoundWallIds.length} walls to ALLOW (Sight: ${WALL_BLOCKING_NONE}, Light: ${WALL_BLOCKING_NONE}).`);
                        const wallUpdatesToAllow = latestFoundWallIds.map(id => ({
                            _id: id,
                            sight: WALL_BLOCKING_NONE, // Use the correct constant value (0)
                            light: WALL_BLOCKING_NONE  // Use the correct constant value (0)
                             // Add move/sound here if needed, check their CONST values too
                        }));
                        try {
                             await sceneAtTimeout.updateEmbeddedDocuments("Wall", wallUpdatesToAllow);
                             console.log(`${LOG_PREFIX} [Timeout ${OPENING_DURATION_MS}ms] Wall update attempt (ALLOW) sent.`);
                             await logWallStatesAfterUpdate(latestFoundWallIds, `Timeout ${OPENING_DURATION_MS}ms - Opening Complete`);
                             ui.notifications.info("Curtain Control: Curtains opened."); // Notify after wall update attempt
                        } catch (wallErr) {
                             console.error(`${LOG_PREFIX} [Timeout ${OPENING_DURATION_MS}ms] Error updating walls (ALLOW):`, wallErr);
                             ui.notifications.error("Curtain Control: Error updating walls for opening. Check console.");
                        }
                    } else {
                         console.log(`${LOG_PREFIX} [Timeout ${OPENING_DURATION_MS}ms] Wall update skipped (walls already appear to be in ALLOW state - ${WALL_BLOCKING_NONE}).`);
                         ui.notifications.info("Curtain Control: Curtains opened."); // Notify even if no update needed
                    }
                 } else {
                     console.log(`${LOG_PREFIX} [Timeout ${OPENING_DURATION_MS}ms] No walls found based on coordinates, skipping wall update for opening completion.`);
                     ui.notifications.info("Curtain Control: Curtains opened (no walls found)."); // Notify animation finished
                 }
            }, OPENING_DURATION_MS); // End of opening timeout
        }

    } catch (err) {
        console.error(`${LOG_PREFIX} CRITICAL Error during state transition initiation:`, err);
        ui.notifications.error("Curtain Control: Transition Error. Check F12 console (GM).");
    } finally {
         console.log(`${LOG_PREFIX} Macro Execution Ended.`);
    }

})(); // End of main async function execution wrapper