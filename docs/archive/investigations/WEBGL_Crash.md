{
  "generatedAt": "2026-06-15T16:05:02.221Z",
  "crash": {
    "at": "2026-06-15T16:04:12.936Z",
    "atMs": 1781539452936,
    "sessionId": "mqfdgy3r-gw5u6e",
    "trigger": "webglcontextlost",
    "module": {
      "id": "map-shine-advanced",
      "version": "0.4.1.2"
    },
    "load": {
      "phase": "fadeIn",
      "coordinatorState": "running",
      "sceneLoading": false,
      "msSinceLoadStart": 1887243,
      "lastLoadDurationMs": 94748
    },
    "visibility": {
      "hidden": false,
      "visibilityState": "visible",
      "hasFocus": false
    },
    "scene": {
      "id": "AgEdsalWg2JMzpLR",
      "name": "Mansion - Multifloor",
      "width": 12000,
      "height": 12000,
      "tiles": 6,
      "tokens": 0,
      "lights": 146,
      "walls": 1005
    },
    "gpu": {
      "contextLost": true,
      "vendor": null,
      "renderer": null,
      "maxTextureSize": null,
      "drawingBufferWidth": 0,
      "drawingBufferHeight": 0,
      "tier": "high"
    },
    "rendererStats": {
      "geometries": 585,
      "textures": 265,
      "programs": 83,
      "renderCalls": 3,
      "triangles": 6,
      "frame": 914096,
      "pixelRatio": 1.3499999046325684
    },
    "graphics": {
      "renderResolutionPreset": "native",
      "performanceProfile": "balanced30",
      "devicePixelRatio": 1.3499999046325684,
      "viewport": {
        "width": 2784,
        "height": 1455
      }
    },
    "memory": {
      "usedJSHeapMB": 4971,
      "totalJSHeapMB": 5051,
      "jsHeapLimitMB": 4192,
      "deviceMemoryGB": 32,
      "hardwareConcurrency": 20
    },
    "browser": {
      "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      "foundryVersion": "14.363"
    },
    "crashHistorySummary": {
      "totalRecorded": 0,
      "withinLast30Min": 0,
      "lastCrashAt": null
    },
    "recentErrors": [
      {
        "at": "2026-06-15T15:32:48.074Z",
        "type": "unhandledrejection",
        "message": "debounce is not defined",
        "stack": "ReferenceError: debounce is not defined\n    at jb2aSettings (https://mythicamachina.com/modules/jb2a_patreon/scripts/settings.js:6:26)\n    at Object.fn (https://mythicamachina.com/modules/jb2a_patreon/scripts/jb2a.js:11:11)\n    at #call (https://mythicamachina.com/scripts/foundry.mjs:26709:20)"
      },
      {
        "at": "2026-06-15T15:32:59.599Z",
        "type": "unhandledrejection",
        "message": "\"jb2a_patreon.runonlyonce\" is not a registered game setting",
        "stack": "Error: \"jb2a_patreon.runonlyonce\" is not a registered game setting\n    at #assertSetting (https://mythicamachina.com/scripts/foundry.mjs:202501:27)\n    at ClientSettings.get (https://mythicamachina.com/scripts/foundry.mjs:202443:40)\n    at Object.fn (https://mythicamachina.com/modules/jb2a_patreon/scripts/jb2a.js:74:27)"
      },
      {
        "at": "2026-06-15T15:32:59.599Z",
        "type": "unhandledrejection",
        "message": "\"jb2a_patreon.jb2aLocation\" is not a registered game setting",
        "stack": "Error: \"jb2a_patreon.jb2aLocation\" is not a registered game setting\n    at #assertSetting (https://mythicamachina.com/scripts/foundry.mjs:202501:27)\n    at ClientSettings.get (https://mythicamachina.com/scripts/foundry.mjs:202443:40)\n    at fixCompImages (https://mythicamachina.com/modules/jb2a_patreon/scripts/jb2a.js:45:43)"
      }
    ],
    "restored": true,
    "restoredAfterMs": 3687,
    "safeModeDowngradeApplied": true
  },
  "diagnosis": [
    "This scene is GPU-heavy (265 textures, ~144 MP map). GPU memory exhaustion is a likely contributor — a lower render resolution preset helps.",
    "JavaScript memory is nearly exhausted (4971 / 4192 MB) — the browser may be under general memory pressure."
  ],
  "safeMode": {
    "active": true,
    "previousPreset": "native",
    "storageKey": "map-shine-advanced.graphicsOverrides.AgEdsalWg2JMzpLR.SLWaa0HoVxjFAQZN",
    "at": 1781539452939,
    "sessionId": "mqfdgy3r-gw5u6e"
  },
  "crashHistory": [
    {
      "at": "2026-06-15T16:04:12.936Z",
      "atMs": 1781539452936,
      "sessionId": "mqfdgy3r-gw5u6e",
      "trigger": "webglcontextlost",
      "sceneId": "AgEdsalWg2JMzpLR",
      "sceneName": "Mansion - Multifloor",
      "phase": "fadeIn",
      "loading": false,
      "hidden": false,
      "gpu": null,
      "preset": "native",
      "restored": true,
      "restoredAfterMs": 3687,
      "safeModeDowngradeApplied": true
    }
  ]
}