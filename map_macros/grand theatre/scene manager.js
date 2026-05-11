/**
 * Macro to change the texture of ALL "stage" tiles based on a predefined list of images,
 * organized into collapsible accordion sections by theme, with larger list item previews above text
 * displayed in a two-column grid within each section. All sections start open.
 * Finds all tiles using any texture in the list and updates them simultaneously.
 * Uses the simpler `Dialog` class for V12 compatibility.
 * V12 Compatible - Dialog Class - Multi-Tile Update - Accordion List (2-Column Grid) - Start Open - Larger List Previews - UI Enhancements.
 *
 * How to Use:
 * 1. Configure the `baseStageDirectory`, `hardcodedFilenames`, and `stageGroups` below.
 *    Ensure ALL filenames in `hardcodedFilenames` are also listed within ONE group in `stageGroups`.
 * 2. Run this macro (no selection needed). It will find all tiles using the listed textures.
 * 3. A dialog will appear showing available textures organized by theme in two columns. All sections start open.
 *    Each item has a larger preview (192x100px approx) above its name.
 *    The currently used texture (if found) will be selected and previewed larger on the right.
 * 4. Click a texture item in the list to select it and update the large preview. Click section headers to close/reopen them.
 * 5. Click "Apply Change to All" to update the texture of ALL identified stage tiles.
 *
 * NOTE:
 * - You MUST configure the `baseStageDirectory`, `hardcodedFilenames`, and `stageGroups` below.
 * - The macro assumes the files listed exist within the `baseStageDirectory`.
 * - Works best if the tiles are unlocked.
 */

(async () => {
    // --- Configuration ---
    const baseStageDirectory = "modules/mythica-machina-grand-theatre/assets/stage"; // CHANGE if needed

    // List ALL filenames you want the macro to potentially manage
    const hardcodedFilenames = [
        "stage-default.png", // Will be prioritized as the first item overall
        "stage-grass-lands.png",
        "stage-rehearsal.png",
        "stage-dry-grass-lands.png",
        "stage-snowy.png",
        "stage-barren.png",
        "stage-arid-bad-lands.png",
        "stage-fey.png",
        "stage-cave-ledge.png",
        "stage-tropical.png",
        "stage-volcanic.png",
        "stage-chasm-bridge.png",
        "stage-castle-wall.png",
        "stage-wizard-tower.png",
        "stage-church.png",
        "stage-tavern.png",
        "stage-market.png",
        "stage-dungeon-entrance.png",
        "stage-altar.png",
        "stage-portal.png",
        "stage-boat.png",
        "stage-ship.png",
        "stage-murder.png",
        "stage-battlefield.png",
        "stage-campfire.png",
        "stage-trap-corridor.png",
    ];

    // Define the groups for the accordion. EVERY filename from hardcodedFilenames MUST appear ONCE here.
    // The order of groups and filenames within groups determines the display order in the dialog.
    const stageGroups = [
        {
            groupName: "Core & Outdoors", // "Default" will be listed first here
            filenames: [
                "stage-default.png",
                "stage-rehearsal.png",
                "stage-grass-lands.png",
                "stage-dry-grass-lands.png",
                "stage-snowy.png",
                "stage-barren.png",
                "stage-battlefield.png", // Added here for grouping
            ],
        },
        {
            groupName: "Natural Environments",
            filenames: [
                "stage-arid-bad-lands.png",
                "stage-fey.png",
                "stage-cave-ledge.png",
                "stage-tropical.png",
                "stage-volcanic.png",
                "stage-chasm-bridge.png",
                "stage-campfire.png", // Added here
            ],
        },
        {
            groupName: "Structures & Locations",
            filenames: [
                "stage-castle-wall.png",
                "stage-wizard-tower.png",
                "stage-church.png",
                "stage-tavern.png",
                "stage-market.png",
                "stage-dungeon-entrance.png",
                "stage-trap-corridor.png", // Added here
                "stage-altar.png",
                "stage-portal.png",
            ],
        },
        {
            groupName: "Specific Scenarios",
            filenames: [
                "stage-boat.png",
                "stage-ship.png",
                "stage-murder.png",
                // Other specific scenarios could go here
            ],
        },
        // Add more groups as needed
    ];

    const defaultFilename = "stage-default.png"; // Explicitly define the default for sorting
    // --- End Configuration ---

    const MACRO_PREFIX = "Stage Changer V12 (Dialog-Multi-Accordion-2Col-Open) |"; // For console logging

    // --- Validation ---
    function validateConfiguration() {
        let isValid = true;
        const groupedFiles = new Set(stageGroups.flatMap(g => g.filenames));
        const hardcodedFiles = new Set(hardcodedFilenames);

        // Check if default exists
        if (!hardcodedFilenames.includes(defaultFilename)) {
            console.error(`${MACRO_PREFIX} Configuration Error: The defaultFilename "${defaultFilename}" is not listed in hardcodedFilenames.`);
            ui.notifications.error(`Macro Configuration Error: Default filename "${defaultFilename}" missing from main list.`);
            isValid = false;
        }
         if (!groupedFiles.has(defaultFilename)) {
            console.error(`${MACRO_PREFIX} Configuration Error: The defaultFilename "${defaultFilename}" is not listed in any stageGroup.`);
            ui.notifications.error(`Macro Configuration Error: Default filename "${defaultFilename}" missing from groups.`);
            isValid = false;
        }

        // Check for files in hardcodedFilenames but not in groups
        for (const file of hardcodedFiles) {
            if (!groupedFiles.has(file)) {
                console.error(`${MACRO_PREFIX} Configuration Error: File "${file}" is in hardcodedFilenames but not in any stageGroup.`);
                ui.notifications.error(`Macro Configuration Error: File "${file}" is missing from groups.`);
                isValid = false;
            }
        }

        // Check for files in groups but not in hardcodedFilenames
        for (const file of groupedFiles) {
            if (!hardcodedFiles.has(file)) {
                console.error(`${MACRO_PREFIX} Configuration Error: File "${file}" is in a stageGroup but not in hardcodedFilenames.`);
                ui.notifications.error(`Macro Configuration Error: File "${file}" is defined in groups but missing from main list.`);
                isValid = false;
            }
        }

        // Check for duplicate filenames across different groups (within the same group is fine, but structure implies unique grouping)
        const allGroupedFiles = stageGroups.flatMap(g => g.filenames);
        if (allGroupedFiles.length !== groupedFiles.size) {
             console.warn(`${MACRO_PREFIX} Configuration Warning: Some filenames might be listed in multiple groups. This is allowed but might be confusing.`);
        }

        return isValid;
    }

    if (!validateConfiguration()) {
        return; // Stop execution if configuration is invalid
    }
    // --- End Validation ---


    /**
     * Finds all TileDocuments in the current scene whose texture source
     * matches one of the configured stage texture paths.
     * @returns {TileDocument[]} An array of matching TileDocuments. Returns empty if scene not loaded or no matches found.
     */
    function findAllStageTileDocs() {
        console.log(`${MACRO_PREFIX} Searching for ALL stage tiles...`);

        if (!canvas.scene) {
             console.warn(`${MACRO_PREFIX} canvas.scene is not available.`);
             ui.notifications.warn("Cannot search for tiles: Scene not loaded.");
             return [];
        }

        if (hardcodedFilenames.length === 0) {
             console.error(`${MACRO_PREFIX} The hardcodedFilenames array is empty! Cannot search.`);
             ui.notifications.error("Macro Configuration Error: No filenames listed to search for.");
             return [];
        }

        // Generate potential paths
        const possibleStagePaths = hardcodedFilenames.map(f => {
            try {
                const fullPath = `${baseStageDirectory}/${f}`;
                return fullPath;
            } catch (e) {
                 console.warn(`${MACRO_PREFIX} Potential issue generating path for filename ${f}: ${baseStageDirectory}/${f}`, e);
                 return null;
            }
        }).filter(Boolean);


        console.log(`${MACRO_PREFIX} Identifying tiles with textures in the configured list.`);

        const foundDocs = canvas.scene.tiles.filter(tDoc => {
            const src = tDoc?.texture?.src;
            if (!src) return false;
            try {
                 const decodedSrc = decodeURIComponent(src);
                 return possibleStagePaths.some(possiblePath => {
                     try {
                         return decodeURIComponent(possiblePath) === decodedSrc;
                     } catch (e) {
                          console.warn(`${MACRO_PREFIX} Error decoding possible path during comparison: ${possiblePath}`, e);
                          return false;
                     }
                 });
            } catch (e) {
                 console.warn(`${MACRO_PREFIX} Malformed URI for tile ${tDoc.id}: ${src}`, e);
                 return false;
            }
        });

        if (foundDocs.length > 0) {
             console.log(`${MACRO_PREFIX} Found ${foundDocs.length} matching TileDocuments.`);
        } else {
             console.warn(`${MACRO_PREFIX} No tiles found matching the configured stage paths.`);
             ui.notifications.warn(`No tiles found matching the configured stage paths in directory: ${baseStageDirectory}`);
        }

        return foundDocs;
    }

    /**
     * Processes a filename into a display name and full path.
     * @param {string} filename - The filename (e.g., "stage-grass-lands.png")
     * @returns {{path: string, name: string, originalFilename: string}}
     */
     function processFilename(filename) {
        const path = `${baseStageDirectory}/${filename}`;
        let name = filename.replace(/\.[^/.]+$/, ""); // Remove extension
        name = name.replace(/^stage-/i, ''); // Remove "stage-" prefix
        name = name.replace(/[-_]/g, ' '); // Replace hyphens/underscores with spaces
        name = name.replace(/\b\w/g, l => l.toUpperCase()); // Capitalize words
        return { path, name, originalFilename: filename };
     }


    // --- Main Logic ---
    if (!canvas.ready) {
        ui.notifications.warn("Canvas is not ready. Please wait and try again.");
        return;
    }

    const targetDocs = findAllStageTileDocs();

    if (targetDocs.length === 0) {
        // Notification already shown in findAllStageTileDocs if needed
        return;
    }

    // Prepare texture data structured by groups
    const textureGroups = stageGroups.map(group => {
         const textures = group.filenames
            .map(filename => processFilename(filename))
            .sort((a, b) => {
                 if (a.originalFilename === defaultFilename) return -1;
                 if (b.originalFilename === defaultFilename) return 1;
                 return a.name.localeCompare(b.name);
            });
         return {
            groupName: group.groupName,
            textures: textures
         };
    }).filter(group => group.textures.length > 0);

    if (textureGroups.length === 0) {
        ui.notifications.error("Macro Error: No textures available after processing groups.");
        return;
    }

    // --- Determine the initially selected path ---
    const allTexturesFlat = textureGroups.flatMap(g => g.textures);
    const defaultTextureInfo = processFilename(defaultFilename);
    const defaultTexturePath = defaultTextureInfo.path;
    let selectedPath = "";

    const currentSrcFromTile = targetDocs[0]?.texture?.src;
    console.log(`${MACRO_PREFIX} Current source from first tile: ${currentSrcFromTile}`);

    if (currentSrcFromTile) {
        try {
            const decodedCurrentSrc = decodeURIComponent(currentSrcFromTile);
            const foundTexture = allTexturesFlat.find(tex => {
                try {
                    return decodeURIComponent(tex.path) === decodedCurrentSrc;
                } catch (e) {
                    console.warn(`${MACRO_PREFIX} Error decoding texture path during comparison: ${tex.path}`, e);
                    return false;
                }
            });

            if (foundTexture) {
                selectedPath = foundTexture.path;
                 console.log(`${MACRO_PREFIX} Found matching texture in list: ${selectedPath}`);
            } else {
                console.log(`${MACRO_PREFIX} Current tile texture (${decodedCurrentSrc}) not found in configured list. Falling back.`);
            }
        } catch (e) {
             console.warn(`${MACRO_PREFIX} Error decoding current tile source URI: ${currentSrcFromTile}`, e);
        }
    } else {
         console.log(`${MACRO_PREFIX} Could not get current texture source from tile. Falling back.`);
    }

    // Fallback logic
    if (!selectedPath) {
         const defaultExistsInList = allTexturesFlat.some(tex => tex.path === defaultTexturePath);
         if (defaultExistsInList) {
             selectedPath = defaultTexturePath;
             console.log(`${MACRO_PREFIX} Using default texture path: ${selectedPath}`);
         } else if (allTexturesFlat.length > 0) {
             selectedPath = allTexturesFlat[0].path;
             console.log(`${MACRO_PREFIX} Default not found or invalid, using first available texture path: ${selectedPath}`);
         }
    }

     if (!selectedPath) {
         console.error(`${MACRO_PREFIX} CRITICAL: Could not determine an initial selected path! No valid textures found.`);
         ui.notifications.error("Macro Error: Cannot determine initial texture. Check configuration and file paths.");
         return;
     }
     // --- End Determine Initial Path ---


    // --- Create Dialog Content ---
    const tileName = `All Stage Tiles (${targetDocs.length} Found)`;

    let accordionHtml = textureGroups.map((group, index) => {
        const groupId = `stage-group-${index}`;
        const textureListHtml = group.textures.map(tex => {
             const pathEsc = Handlebars.Utils.escapeExpression(tex.path);
             const nameEsc = Handlebars.Utils.escapeExpression(tex.name);
             const isSelected = tex.path === selectedPath ? ' selected' : '';
             // HTML Structure for list item (Preview above Text)
             return `
                <li data-path="${pathEsc}" title="${pathEsc}" class="texture-item${isSelected}">
                    <div class="texture-item-preview">
                         <img src="${pathEsc}" alt="${nameEsc} Preview" loading="lazy" onerror="this.style.display='none'; this.parentElement.classList.add('error');">
                    </div>
                    <div class="texture-item-details">
                         <i class="fas fa-image"></i>
                         <span>${nameEsc}</span>
                    </div>
                </li>`;
         }).join('');

        // --- MODIFICATION: Always start open ---
        // const containsSelected = group.textures.some(tex => tex.path === selectedPath);
        // const startOpen = containsSelected; // OLD logic
        const startOpen = true; // NEW: Always open

        return `
            <div class="accordion-item">
                 <div class="accordion-header${startOpen ? ' active' : ''}" data-target="#${groupId}">
                     <i class="fas fa-chevron-right accordion-icon"></i> ${Handlebars.Utils.escapeExpression(group.groupName)}
                 </div>
                 <div id="${groupId}" class="accordion-content" ${startOpen ? 'style="max-height: none;"' : ''}>
                     <ul class="file-list">
                         ${textureListHtml}
                     </ul>
                 </div>
            </div>
        `;
     }).join('');

    if (!accordionHtml) accordionHtml = '<p>No texture groups defined or available.</p>';

    const initialSelectedPathEsc = Handlebars.Utils.escapeExpression(selectedPath);

    const dialogContentHtml = `
        <div class="dialog-stage-changer-v12 multi accordion">
            <div class="stage-changer-content">
                <div class="file-list-column">
                    <h3 class="column-header">
                        Available Scenes <span class="tile-name">(${tileName})</span>
                    </h3>
                    <div id="stage-changer-accordion" class="accordion-container">
                        ${accordionHtml}
                    </div>
                </div>
                <div class="preview-column">
                     <h3 class="column-header">
                        Preview
                     </h3>
                     <div class="preview-box">
                       <img id="stage-preview-image" src="${initialSelectedPathEsc}" alt="Texture Preview" onerror="this.style.display='none'; this.parentElement.querySelector('.preview-error').style.display='block';" />
                       <span class="preview-error" style="display: none;">Failed to load preview image.<br>Check path/file existence.</span>
                     </div>
                     <div id="stage-preview-path" class="preview-path" title="${initialSelectedPathEsc}">
                        ${initialSelectedPathEsc}
                     </div>
                </div>
            </div>
            <style>
                /* --- Overall Dialog Layout --- */
                .dialog-stage-changer-v12.multi .stage-changer-content {
                    display: flex; gap: 15px; min-height: 500px; /* Increased min height slightly */ height: 100%;
                }
                .dialog-stage-changer-v12.multi .file-list-column {
                    flex: 4; /* Give list slightly more relative space for 2 columns */
                    display: flex; flex-direction: column; border: 1px solid var(--color-border-medium);
                    border-radius: 5px; overflow: hidden; background: var(--color-background-surface-1);
                    max-height: 80vh; /* Allow slightly more height */
                }
                .dialog-stage-changer-v12.multi .preview-column {
                    flex: 6; /* Preview slightly less relative space */
                    display: flex; flex-direction: column; border: 1px solid var(--color-border-medium);
                    border-radius: 5px; overflow: hidden; background: var(--color-background-surface-1);
                    max-height: 80vh;
                }
                .dialog-stage-changer-v12.multi .column-header {
                    margin: 0; padding: 10px 12px; background: var(--color-background-header);
                    border-bottom: 1px solid var(--color-border-medium); font-size: var(--font-size-18);
                    text-align: center; flex-shrink: 0; color: var(--color-text-header); font-weight: 700;
                }
                 .dialog-stage-changer-v12.multi .column-header .tile-name {
                    font-size: 0.75em; color: var(--color-text-muted); font-weight: normal;
                    display: block; margin-top: 2px;
                }

                /* --- Accordion --- */
                 .dialog-stage-changer-v12.multi .accordion-container {
                    overflow-y: auto; flex-grow: 1; padding: 5px; /* Add padding around accordion items */
                 }
                .dialog-stage-changer-v12.multi .accordion-item {
                    border: 1px solid var(--color-border-medium); /* Border around each item */
                    border-radius: 3px;
                    margin-bottom: 8px; /* Space between items */
                    overflow: hidden; /* Ensure content clip */
                    background: var(--color-background-surface-2); /* BG for item */

                }
                /* .dialog-stage-changer-v12.multi .accordion-item:last-child { border-bottom: none; } */ /* Removed */
                .dialog-stage-changer-v12.multi .accordion-header {
                    padding: 10px 15px; cursor: pointer; background-color: var(--color-background-surface-3); /* Header BG */
                    font-weight: bold; font-size: var(--font-size-16); display: flex; align-items: center;
                    gap: 10px; transition: background-color 0.15s ease;
                    border-bottom: 1px solid var(--color-border-light); /* Line below header */
                    /* border-top: 1px solid var(--color-border-light); */ /* Removed */
                }
                 /* .dialog-stage-changer-v12.multi .accordion-item:first-child .accordion-header { border-top: none; } */ /* Removed */
                .dialog-stage-changer-v12.multi .accordion-header:hover { background-color: var(--color-background-hover-highlight); }
                .dialog-stage-changer-v12.multi .accordion-icon {
                    transition: transform 0.2s ease-in-out; width: 12px; text-align: center; flex-shrink: 0;
                }
                /* Icon starts rotated if active */
                .dialog-stage-changer-v12.multi .accordion-header.active .accordion-icon { transform: rotate(90deg); }
                .dialog-stage-changer-v12.multi .accordion-content {
                    /* Max-height controls animation, set in JS */
                    overflow: hidden; transition: max-height 0.3s ease-out;
                    background: var(--color-background-surface-1); /* Content BG */
                    padding: 10px; /* Padding inside content area */
                }
                /* Style for when explicitly set to open */
                 .dialog-stage-changer-v12.multi .accordion-content[style*="max-height: none"] {
                    overflow: visible; /* Allow content to naturally flow when open */
                 }

                /* --- File List (Grid Layout) --- */
                .dialog-stage-changer-v12.multi .accordion-content ul.file-list {
                    list-style: none; padding: 0; margin: 0;
                    display: grid; /* <<< USE GRID >>> */
                    grid-template-columns: repeat(2, 1fr); /* <<< TWO COLUMNS >>> */
                    gap: 15px; /* <<< GAP BETWEEN GRID ITEMS >>> */
                }

                /* --- Texture List Item Styling (Inside Grid) --- */
                .dialog-stage-changer-v12.multi .texture-item {
                    display: flex;
                    flex-direction: column; /* Stack preview and details vertically */
                    align-items: center; /* Center items horizontally */
                    padding: 10px; /* Padding within the item */
                    cursor: pointer;
                    /* border-top: 1px solid var(--color-border-light); */ /* Removed, grid gap handles separation */
                    color: var(--color-text-standard);
                    transition: background-color 0.15s ease, box-shadow 0.15s ease;
                    min-height: 140px; /* Adjusted height for larger image + text */
                    text-align: center;
                    background-color: var(--color-background-surface-2); /* BG for item */
                    border-radius: 4px;
                    border: 1px solid var(--color-border-light);
                    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
                }
                /* .dialog-stage-changer-v12.multi .accordion-content ul.file-list li:first-child { border-top: none; } */ /* Removed */
                .dialog-stage-changer-v12.multi .texture-item:hover {
                    background-color: var(--color-background-hover-highlight);
                    box-shadow: 0 2px 5px rgba(0,0,0,0.15);
                    border-color: var(--color-border-highlight);
                }
                .dialog-stage-changer-v12.multi .texture-item.selected {
                    background-color: var(--color-background-info-highlight); font-weight: bold;
                    color: var(--color-text-on-info);
                    border-color: var(--color-border-info-focus);
                    box-shadow: 0 0 0 2px var(--color-border-info-highlight);
                }

                /* Texture List Item - Preview Image Container */
                .dialog-stage-changer-v12.multi .texture-item-preview {
                    width: 192px;  /* Keep desired width */
                    height: 100px; /* Keep desired height */
                    border-radius: 3px;
                    overflow: hidden;
                    background-color: var(--color-background-well); /* Fallback bg */
                    border: 1px solid var(--color-border-light);
                    margin-bottom: 8px; /* Increased space between image and text */
                    flex-shrink: 0;
                    position: relative;
                }
                 .dialog-stage-changer-v12.multi .texture-item-preview.error {
                      border-color: var(--color-border-error);
                 }
                .dialog-stage-changer-v12.multi .texture-item-preview img {
                    display: block; width: 100%; height: 100%; object-fit: cover;
                }
                .dialog-stage-changer-v12.multi .texture-item.selected .texture-item-preview { border-color: rgba(255, 255, 255, 0.5); } /* Lighter border on selected */

                /* Texture List Item - Details (Icon + Name below preview) */
                .dialog-stage-changer-v12.multi .texture-item-details {
                    display: flex; align-items: center; justify-content: center;
                    gap: 5px; width: 100%; overflow: hidden; flex-shrink: 0;
                    margin-top: 3px;
                }
                 .dialog-stage-changer-v12.multi .texture-item-details i {
                     color: var(--color-icon-inactive); flex-shrink: 0; font-size: 0.9em;
                 }
                 .dialog-stage-changer-v12.multi .texture-item.selected .texture-item-details i { color: var(--color-text-on-info); }
                 .dialog-stage-changer-v12.multi .texture-item-details span {
                    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                    max-width: calc(100% - 20px); /* Prevent span touching edges */
                    font-size: var(--font-size-13); /* Slightly larger text */
                 }

                /* --- Preview Area (Right Side) --- */
                .dialog-stage-changer-v12.multi .preview-box {
                    flex-grow: 1; display: flex; justify-content: center; align-items: center;
                    overflow: hidden; background-color: var(--color-background-well); margin: 15px;
                    min-height: 200px; border: 1px solid var(--color-border-medium); border-radius: 5px;
                    position: relative;
                }
                .dialog-stage-changer-v12.multi .preview-box img {
                    max-width: 100%; max-height: 100%; height: auto; width: auto;
                    object-fit: contain; display: block; border-radius: 3px;
                }
                .dialog-stage-changer-v12.multi .preview-error {
                    display: none; color: var(--color-text-error); text-align: center;
                    padding: 15px; font-size: var(--font-size-14);
                }
                .dialog-stage-changer-v12.multi .preview-path {
                    font-size: var(--font-size-13); color: var(--color-text-standard); text-align: center;
                    word-break: break-all; padding: 8px 15px; border-top: 1px solid var(--color-border-medium);
                    background: var(--color-background-surface-2); max-height: 5em; overflow-y: auto;
                    flex-shrink: 0; font-family: monospace;
                }
            </style>
        </div>
    `;

    // --- Create and Render the Dialog ---
    console.log(`${MACRO_PREFIX} Creating Dialog for ${targetDocs.length} tiles. Initial selection: ${selectedPath}`);

    new Dialog({
        title: "Change Stage Scenery (All Matching Tiles)",
        content: dialogContentHtml,
        buttons: {
            apply: {
                icon: '<i class="fas fa-check"></i>',
                label: "Apply Change to All",
                callback: async (html) => {
                    console.log(`${MACRO_PREFIX} Apply button clicked. Selected Path: ${selectedPath}`);
                    if (!selectedPath) {
                        ui.notifications.warn("No texture selected to apply.");
                        return;
                    }

                    const updatesToPerform = targetDocs.filter(doc => {
                        try {
                            const decodedCurrent = decodeURIComponent(doc.texture?.src || '');
                            const decodedSelected = decodeURIComponent(selectedPath);
                            return decodedCurrent !== decodedSelected;
                        } catch (e) {
                             console.warn(`${MACRO_PREFIX} Malformed URI during update check for tile ${doc.id} (current: ${doc.texture?.src}, selected: ${selectedPath})`, e);
                             return true;
                        }
                    });


                    if (updatesToPerform.length === 0) {
                         ui.notifications.info(`Selected texture is already applied to all ${targetDocs.length} target tile(s). No changes needed.`);
                         return;
                    }

                    console.log(`${MACRO_PREFIX} Queueing updates for ${updatesToPerform.length} out of ${targetDocs.length} tiles.`);
                    ui.notifications.info(`Updating ${updatesToPerform.length} stage tile(s)...`);

                    const updatePromises = updatesToPerform.map(doc => {
                        console.log(`${MACRO_PREFIX} - Updating TileDocument ${doc.id} to ${selectedPath}`);
                        return doc.update({ "texture.src": selectedPath });
                    });

                    try {
                        console.log(`${MACRO_PREFIX} Applying updates...`);
                        await Promise.all(updatePromises);

                        console.log(`${MACRO_PREFIX} ${updatesToPerform.length} tile(s) updated successfully.`);
                        const friendlyName = selectedPath.substring(selectedPath.lastIndexOf('/') + 1);
                        ui.notifications.info(`Updated ${updatesToPerform.length} stage tile(s) to '${friendlyName}'. (${targetDocs.length} total stage tiles found).`);

                    } catch (err) {
                        console.error(`${MACRO_PREFIX} Failed to update one or more tiles:`, err);
                        ui.notifications.error(`Error updating tiles: ${err.message || err}. Some tiles might not have updated.`);
                    }
                }
            },
            cancel: {
                icon: '<i class="fas fa-times"></i>',
                label: "Cancel",
                callback: () => { console.log(`${MACRO_PREFIX} Cancel button clicked.`); }
            }
        },
        default: "apply",
        render: (html) => {
            console.log(`${MACRO_PREFIX} Dialog rendered. Attaching listeners...`);
            const previewImage = html.find('#stage-preview-image');
            const previewPathDisplay = html.find('#stage-preview-path');
            const accordionContainer = html.find('#stage-changer-accordion');
            const previewError = html.find('.preview-error');

            if (!previewImage.length || !previewPathDisplay.length || !accordionContainer.length || !previewError.length) {
                 console.error(`${MACRO_PREFIX} Could not find all required UI elements in the dialog.`);
                 return;
            }

            // Accordion Toggle Logic (remains the same, allows closing/opening)
            accordionContainer.on('click', '.accordion-header', function(event) {
                const header = $(this);
                const content = header.next('.accordion-content');
                const icon = header.find('.accordion-icon');

                // --- Logic to close OTHER sections remains commented out - Keep all open unless explicitly closed ---
                // if (!header.hasClass('active')) { ... }

                // Toggle current section
                header.toggleClass('active');
                icon.css('transform', header.hasClass('active') ? 'rotate(90deg)' : 'rotate(0deg)');

                // Animate open/close
                if (header.hasClass('active')) {
                     // Calculate scrollHeight before setting max-height
                     const scrollHeight = content.prop('scrollHeight');
                     content.css('max-height', scrollHeight + 'px');
                     // Set to 'none' after transition ONLY IF still active
                     content.off('transitionend').one('transitionend', function() {
                         if (header.hasClass('active')) {
                             try { content.css('max-height', 'none'); } catch (e) {}
                         }
                     });
                     // Fallback timeout
                     setTimeout(() => {
                         try {
                             if (header.hasClass('active') && content.css('max-height') !== '0px') {
                                 content.css('max-height', 'none');
                             }
                         } catch(e) {}
                     }, 350); // duration + buffer
                } else {
                     // Set max-height back to scrollHeight before animating to 0
                     content.css('max-height', content.prop('scrollHeight') + 'px');
                     void content.prop('offsetHeight'); // Force reflow/repaint
                     content.css('max-height', '0px');
                }
            });

             // --- MODIFICATION: Set initial state for ALL accordions to open ---
            accordionContainer.find('.accordion-header').each(function() {
                 const header = $(this);
                 const icon = header.find('.accordion-icon');
                 const content = header.next('.accordion-content');

                 // Assume it starts active (from HTML generation)
                 icon.css('transform', 'rotate(90deg)');
                 // Start open: Set to scrollHeight first for potential initial animation,
                 // then set to 'none' after a very short delay to allow natural height.
                 try {
                     const scrollHeight = content.prop('scrollHeight');
                     content.css('max-height', scrollHeight + 'px');
                     // Use a short timeout to switch to max-height: none after initial rendering
                     setTimeout(() => {
                         // Double-check it should still be open before setting to none
                         if (header.hasClass('active')) {
                              content.css('max-height', 'none');
                         }
                     }, 50); // 50ms delay
                 } catch(e) {
                     content.css('max-height', 'none'); // Fallback if scrollHeight fails
                 }
            });


            // Texture Selection Logic (remains the same)
            accordionContainer.on('click', '.texture-item', (event) => {
                const targetLi = $(event.currentTarget);
                const path = targetLi.data('path');

                if (!path || path === selectedPath) return;

                selectedPath = path;
                 console.log(`${MACRO_PREFIX} Texture selected via click: ${selectedPath}`);

                accordionContainer.find('.texture-item.selected').removeClass('selected');
                targetLi.addClass('selected');

                // Update main preview
                previewImage.show();
                previewError.hide();
                previewImage.attr('src', path);
                const escapedPath = Handlebars.Utils.escapeExpression(path);
                previewPathDisplay.text(escapedPath);
                previewPathDisplay.attr('title', escapedPath);
            });

            // Initial state handled by HTML src/onerror

            console.log(`${MACRO_PREFIX} Listeners attached.`);
        },
        close: () => {
             console.log(`${MACRO_PREFIX} Dialog closed.`);
        }
    }, {
        width: 1200, // Increased width for two columns
        height: 'auto', // Allow height to adjust
        resizable: true,
        id: `stage-changer-dialog-multi-${canvas.scene?.id || 'no-scene'}`,
        classes: ["dialog", "dialog-stage-changer-outer"]
    }).render(true);

})();