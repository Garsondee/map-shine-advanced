/*******************************************************
 * Vault Scene Controller (v18 - Final Version)
 * -----------------------------------------------------
 * This version implements a clean, tabbed interface and
 * includes all requested control logic for tiles,
 * walls, and lights.
 *
 * 1. Scans for all necessary lights and tiles.
 * 2. Caches their IDs for guaranteed updates.
 * 3. Controls tile states, light visibility, and wall states.
 * 4. UI organized into tabs for a clean and compact dialog.
 * 5. Added dynamic light control for the tunnel sequence.
 * 6. Tunnel overlay appears from the second stage onwards.
 * 7. Wall explosion state now controls a specific door.
 *******************************************************/

console.log("--- Vault Scene Controller (v18 - Final Version) START ---");

// --- CONFIGURATION ---
const ASSET_PATH = "modules/mythica-machina-big-bank/assets/";
const BURNING_LIGHT_COLOR = "#ff5a1c";
const SUCCESS_LIGHT_COLOR = "#ff881c";

// --- TILE TEXTURES ---
const TREASURE_TEXTURES = [ { id: "Vault_Treasure_00_Empty.webp", name: "Vault Completely Empty" }, { id: "Vault_Treasure_01.webp", name: "Treasure Pile 1" }, { id: "Vault_Treasure_01_Empty.webp", name: "Treasure Pile 1 (Empty)" }, { id: "Vault_Treasure_02.webp", name: "Treasure Pile 2" }, { id: "Vault_Treasure_02_Empty.webp", name: "Treasure Pile 2 (Empty)" }, { id: "Vault_Treasure_03.webp", name: "Treasure Pile 3" }, { id: "Vault_Treasure_03_Empty.webp", name: "Treasure Pile 3 (Empty)" }, { id: "Vault_Treasure_04.webp", name: "Treasure Pile 4" }, { id: "Vault_Treasure_04_Empty.webp", name: "Treasure Pile 4 (Empty)" }, { id: "Vault_Treasure_05.webp", name: "Treasure Pile 5" }, { id: "Vault_Treasure_06_Empty.webp", name: "Treasure Piles 5 & 6 (Empty)" }, { id: "Vault_Treasure_Devices_06.webp", name: "Treasure Pile 6 (Devices)" }, { id: "Vault_Treasure_Paintings_06.webp", name: "Treasure Pile 6 (Paintings)" }, { id: "Vault_Treasure_Potions_06.webp", name: "Treasure Pile 6 (Potions)" }, { id: "Vault_Treasure_07.webp", name: "Treasure Pile 7" }, { id: "Vault_Treasure_08.webp", name: "Treasure Pile 8" }, { id: "Vault_Treasure_09.webp", name: "Treasure Pile 9" }, { id: "Vault_Treasure_10.webp", name: "Treasure Pile 10" }, { id: "Vault_Treasure_11.webp", name: "Treasure Pile 11" }, { id: "Vault_Treasure_12.webp", name: "Treasure Pile 12" }, { id: "Vault_Treasure_12_Empty.webp", name: "Treasure Pile 12 (Empty)" }];
const LANCE_TEXTURES = [ { id: "Vault_Thermic_Lance_Empty.webp", name: "Lance (Not Present)" }, { id: "Vault_Thermic_Lance_Present.webp", name: "Lance (Present)" }, { id: "Vault_Thermic_Lance_Burning.webp", name: "Lance (Burning)" }, { id: "Vault_Thermic_Lance_Success.webp", name: "Lance (Success)" }, { id: "Vault_Thermic_Lance_Removed_Success.webp", name: "Lance (Removed After Success)" }];
const WALL_EXPLOSION_TEXTURES = [ { id: "Vault_Wall_Explode_Before.webp", name: "Wall Intact" }, { id: "Vault_Wall_Explode_Bags_Placed.webp", name: "Explosives Placed" }, { id: "Vault_Wall_Explode_Wall_Destroyed.webp", name: "Wall Destroyed" }];
const TUNNEL_TEXTURES = [ { id: "Tunnel_01.webp", name: "Tunnel Not Started" }, { id: "Tunnel_02.webp", name: "Tunnel Started" }, { id: "Tunnel_03.webp", name: "Tunnel Progressing" }, { id: "Tunnel_04.webp", name: "Tunnel Reaches Bank Vault Wall" }, { id: "Tunnel_End.webp", name: "Tunnel Breaches Bank Vault Wall" }, { id: "Tunnel_Collapse.webp", name: "Tunnel Collapses!" } ];


// --- DOOR CONFIGURATION ---
const COLLAPSE_DOOR_ID = "hIwsqYxwSZIaajZx";
const WALL_EXPLOSION_DOOR_ID = "BPq6Utp8hMM1i4xv";
const TUNNEL_DOOR_CONFIG = {
    "Tunnel_01.webp": [COLLAPSE_DOOR_ID],
    "Tunnel_02.webp": ["7bkZZLP1JoWHziSq", COLLAPSE_DOOR_ID],
    "Tunnel_03.webp": ["7bkZZLP1JoWHziSq", "SgK2QoSCRMZISP7o", COLLAPSE_DOOR_ID],
    "Tunnel_04.webp": ["7bkZZLP1JoWHziSq", "SgK2QoSCRMZISP7o", "QcKMVl2QxlkwcNC1", COLLAPSE_DOOR_ID],
    "Tunnel_End.webp": ["7bkZZLP1JoWHziSq", "SgK2QoSCRMZISP7o", "QcKMVl2QxlkwcNC1", "zt38CSvxSxFuycyZ", COLLAPSE_DOOR_ID],
    "Tunnel_Collapse.webp": ["7bkZZLP1JoWHziSq", "SgK2QoSCRMZISP7o", "QcKMVl2QxlkwcNC1", "zt38CSvxSxFuycyZ"]
};
const ALL_TUNNEL_DOOR_IDS = [...new Set(Object.values(TUNNEL_DOOR_CONFIG).flat())];

// --- TUNNEL LIGHT CONFIGURATION ---
const TUNNEL_LIGHT_1_ID = "gJ5TRDfETOqSmklW";
const TUNNEL_LIGHT_2_ID = "bK0Gp2yWtgrRngAl";
const ALL_TUNNEL_LIGHT_IDS = [TUNNEL_LIGHT_1_ID, TUNNEL_LIGHT_2_ID];
const TUNNEL_LIGHT_CONFIG = {
    "Tunnel_01.webp": [],
    "Tunnel_02.webp": [],
    "Tunnel_03.webp": [TUNNEL_LIGHT_1_ID],
    "Tunnel_04.webp": [TUNNEL_LIGHT_1_ID, TUNNEL_LIGHT_2_ID],
    "Tunnel_End.webp": [TUNNEL_LIGHT_1_ID, TUNNEL_LIGHT_2_ID],
    "Tunnel_Collapse.webp": [TUNNEL_LIGHT_1_ID, TUNNEL_LIGHT_2_ID]
};


// --- HELPER FUNCTIONS ---
function hexToRgb(hex) {
    if (!hex) return null;
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? [parseInt(result[1], 16) / 255, parseInt(result[2], 16) / 255, parseInt(result[3], 16) / 255] : null;
}

function areColorsClose(rgb1, rgb2) {
    if (!rgb1 || !rgb2) return false;
    const tolerance = 0.02;
    return Math.abs(rgb1[0] - rgb2[0]) < tolerance && Math.abs(rgb1[1] - rgb2[1]) < tolerance && Math.abs(rgb1[2] - rgb2[2]) < tolerance;
}


// --- MACRO LOGIC ---

// 1. Find Tiles
const treasureTileDoc = canvas.scene.tiles.find(tile => TREASURE_TEXTURES.some(tex => tile.texture.src.endsWith(tex.id)));
const lanceTileDoc = canvas.scene.tiles.find(tile => LANCE_TEXTURES.some(tex => tile.texture.src.endsWith(tex.id)));
const wallExplosionTileDoc = canvas.scene.tiles.find(tile => WALL_EXPLOSION_TEXTURES.some(tex => tile.texture.src.endsWith(tex.id)));
const tunnelTileDoc = canvas.scene.tiles.find(tile => TUNNEL_TEXTURES.some(tex => tile.texture.src.endsWith(tex.id)));
const tunnelOverlayDoc = canvas.scene.tiles.find(tile => tile.texture.src.endsWith("Tunnel_End_Overlay.webp"));


if (!treasureTileDoc && !lanceTileDoc && !wallExplosionTileDoc && !tunnelTileDoc) {
    ui.notifications.error("None of the required tiles (Treasure, Lance, Wall, Tunnel) could be found.");
    return;
}

// 2. Scan for Lights and Store their IDs
let burningLightId = null;
let successLightId = null;
const burningRgbTarget = hexToRgb(BURNING_LIGHT_COLOR);
const successRgbTarget = hexToRgb(SUCCESS_LIGHT_COLOR);
for (const light of canvas.lighting.placeables) {
    // v14+: point source is `lightSource` (may be undefined if the light is inactive). Older builds used `source`.
    const pointSource = light.lightSource ?? light.source;
    let lightRgb = pointSource?.colorRGB;
    if (!lightRgb) {
        const docColor = light.document?.config?.color;
        if (docColor != null) lightRgb = Color.from(docColor).rgb;
    }
    if (!lightRgb) continue;
    if (areColorsClose(lightRgb, burningRgbTarget)) burningLightId = light.document.id;
    if (areColorsClose(lightRgb, successRgbTarget)) successLightId = light.document.id;
}


// 3. Helper function to generate the HTML for a single tab's content.
function createTabContent(selectId, previewId, tileDoc, textureList) {
    if (!tileDoc) {
        return `<p class="notes"><em>Required tile for this section not found on the current scene.</em></p>`;
    }
    const currentSrc = tileDoc.texture.src;
    const options = textureList.map(t => `<option value="${ASSET_PATH + t.id}" ${ASSET_PATH + t.id === currentSrc ? "selected" : ""}>${t.name}</option>`).join('');
    
    return `
      <div class="control-grid">
          <div class="preview-container">
              <img id="${previewId}" src="${currentSrc}" alt="Current state preview"/>
          </div>
          <div class="select-container">
              <label for="${selectId}">Select State</label>
              <select id="${selectId}" size="10">${options}</select>
          </div>
      </div>`;
}

// 4. Prepare dialog content with a tabbed interface.
const dialogContent = `
<div class="vault-controller-tabs">
    <style>
        .vault-controller-tabs nav.tabs { border-bottom: 1px solid #a9a9a9; margin-bottom: 10px; }
        .vault-controller-tabs nav.tabs .item { border-radius: 5px 5px 0 0; border-bottom: none; }
        .vault-controller-tabs .tab-content { display: none; }
        .vault-controller-tabs .tab-content.active { display: block; }
        .control-grid { display: grid; grid-template-columns: 250px 1fr; gap: 15px; align-items: start; }
        .preview-container { border: 1px solid #7a7971; background: #2b2b2b; display: flex; align-items: center; justify-content: center; height: 220px; border-radius: 3px; overflow: hidden; }
        .preview-container img { max-width: 100%; max-height: 100%; }
        .select-container { display: flex; flex-direction: column; height: 100%; }
        .select-container label { font-weight: bold; margin-bottom: 5px; }
        .select-container select { height: 220px; }
        .notes { padding: 10px; background: rgba(255, 0, 0, 0.05); border: 1px solid #802020; border-radius: 5px; }
    </style>

    <nav class="sheet-tabs tabs" data-group="primary">
        <a class="item active" data-tab="treasure"><i class="fas fa-gem"></i> Treasure</a>
        <a class="item" data-tab="lance"><i class="fas fa-fire"></i> Thermic Lance</a>
        <a class="item" data-tab="wall"><i class="fas fa-bomb"></i> Wall Explosion</a>
        <a class="item" data-tab="tunnel"><i class="fas fa-dungeon"></i> Tunnel</a>
    </nav>

    <section class="content">
        <div class="tab-content active" data-tab="treasure">
            ${createTabContent("treasure-selection", "treasure-preview", treasureTileDoc, TREASURE_TEXTURES)}
        </div>
        <div class="tab-content" data-tab="lance">
            ${createTabContent("lance-selection", "lance-preview", lanceTileDoc, LANCE_TEXTURES)}
        </div>
        <div class="tab-content" data-tab="wall">
            ${createTabContent("wall-explosion-selection", "wall-explosion-preview", wallExplosionTileDoc, WALL_EXPLOSION_TEXTURES)}
        </div>
        <div class="tab-content" data-tab="tunnel">
            ${createTabContent("tunnel-selection", "tunnel-preview", tunnelTileDoc, TUNNEL_TEXTURES)}
        </div>
    </section>
</div>
`;


// 5. Create and render the Dialog application.
new Dialog({
    title: "Vault Scene Controller",
    content: dialogContent,
    buttons: {
        apply: {
            icon: '<i class="fas fa-check"></i>',
            label: "Apply Changes",
            callback: async (html) => {
                const lightUpdates = [];
                const wallUpdates = [];
                let updatesMade = false;

                // --- Treasure Tile ---
                if (treasureTileDoc) {
                    const newTreasure = html.find('#treasure-selection').val();
                    if (newTreasure !== treasureTileDoc.texture.src) {
                        await treasureTileDoc.update({ "texture.src": newTreasure });
                        updatesMade = true;
                    }
                }

                // --- Lance Tile & Lights ---
                if (lanceTileDoc) {
                    const newLance = html.find('#lance-selection').val();
                    if (newLance !== lanceTileDoc.texture.src) {
                        await lanceTileDoc.update({ "texture.src": newLance });
                        updatesMade = true;
                    }
                    if (burningLightId) lightUpdates.push({ _id: burningLightId, hidden: !newLance.endsWith("Vault_Thermic_Lance_Burning.webp") });
                    if (successLightId) lightUpdates.push({ _id: successLightId, hidden: !(newLance.endsWith("Vault_Thermic_Lance_Success.webp") || newLance.endsWith("Vault_Thermic_Lance_Removed_Success.webp")) });
                }
                
                // --- Wall Explosion Tile & Door ---
                if (wallExplosionTileDoc) {
                    const newWallState = html.find('#wall-explosion-selection').val();
                    if (newWallState !== wallExplosionTileDoc.texture.src) {
                         await wallExplosionTileDoc.update({ "texture.src": newWallState });
                         updatesMade = true;
                    }
                    
                    // Control the associated door
                    const wallDoc = canvas.scene.walls.get(WALL_EXPLOSION_DOOR_ID);
                    if (wallDoc) {
                        const shouldBeOpen = newWallState.endsWith("Vault_Wall_Explode_Wall_Destroyed.webp");
                        const newState = shouldBeOpen ? 1 : 0; // 1 = open, 0 = closed
                        if (wallDoc.ds !== newState) {
                            wallUpdates.push({ _id: WALL_EXPLOSION_DOOR_ID, ds: newState });
                        }
                    } else {
                        console.warn(`Wall Explosion door ID "${WALL_EXPLOSION_DOOR_ID}" not found in scene.`);
                    }
                }

                // --- Tunnel Tile, Overlay, Doors & Lights ---
                if (tunnelTileDoc) {
                    const newTunnelState = html.find('#tunnel-selection').val();
                    if (newTunnelState !== tunnelTileDoc.texture.src) {
                        await tunnelTileDoc.update({ "texture.src": newTunnelState });
                        updatesMade = true;
                    }
                    
                    if (tunnelOverlayDoc) {
                        const shouldBeHidden = newTunnelState.endsWith("Tunnel_01.webp");
                        if (tunnelOverlayDoc.hidden !== shouldBeHidden) {
                            await tunnelOverlayDoc.update({ hidden: shouldBeHidden });
                        }
                    } else {
                        if (!newTunnelState.endsWith("Tunnel_01.webp")) {
                            ui.notifications.warn("Could not find 'Tunnel_End_Overlay.webp' tile to display.");
                        }
                    }

                    const textureFilename = newTunnelState.split('/').pop();

                    // Door Control Logic
                    const doorsToOpen = TUNNEL_DOOR_CONFIG[textureFilename] || [];
                    for (const doorId of ALL_TUNNEL_DOOR_IDS) {
                        const wallDoc = canvas.scene.walls.get(doorId);
                        if (!wallDoc) {
                            console.warn(`Tunnel door ID "${doorId}" not found in scene.`);
                            continue;
                        }
                        const newState = doorsToOpen.includes(doorId) ? 1 : 0;
                        if (wallDoc.ds !== newState) wallUpdates.push({ _id: doorId, ds: newState });
                    }

                    // Light Control Logic
                    const lightsToTurnOn = TUNNEL_LIGHT_CONFIG[textureFilename] || [];
                    for (const lightId of ALL_TUNNEL_LIGHT_IDS) {
                        const lightDoc = canvas.scene.lights.get(lightId);
                        if (!lightDoc) {
                             console.warn(`Tunnel light ID "${lightId}" not found in scene.`);
                             continue;
                        }
                        const shouldBeHidden = !lightsToTurnOn.includes(lightId);
                        if (lightDoc.hidden !== shouldBeHidden) {
                            lightUpdates.push({ _id: lightId, hidden: shouldBeHidden });
                        }
                    }
                }

                // --- Apply all collected updates ---
                const updatePromises = [];
                if (lightUpdates.length > 0) updatePromises.push(canvas.scene.updateEmbeddedDocuments("AmbientLight", lightUpdates));
                if (wallUpdates.length > 0) updatePromises.push(canvas.scene.updateEmbeddedDocuments("Wall", wallUpdates));
                
                if (updatePromises.length > 0) await Promise.all(updatePromises);
                
                if (updatePromises.length > 0 || updatesMade) {
                    ui.notifications.info("Vault scene elements have been updated.");
                }
            }
        },
        cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
    },
    default: "apply",
    render: (html) => {
        const tabs = html.find('.tabs');
        tabs.on('click', '.item', (event) => {
            const tab = $(event.currentTarget);
            const tabName = tab.data('tab');
            tabs.find('.item').removeClass('active');
            html.find('.tab-content').removeClass('active');
            tab.addClass('active');
            html.find(`.tab-content[data-tab="${tabName}"]`).addClass('active');
        });

        html.find('select').change(e => {
            const selectElement = $(e.currentTarget);
            const newSrc = selectElement.val();
            const previewImg = selectElement.closest('.control-grid').find('.preview-container img');
            if (previewImg.length) {
                previewImg.attr('src', newSrc);
            }
        });
    }
}, { width: 600, height: "auto", resizable: true }).render(true);