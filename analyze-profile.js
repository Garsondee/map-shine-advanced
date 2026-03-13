const fs = require('fs');

const filePath = 'performance/Firefox 2026-03-13 12.44 profile.json(1)';
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

const mainThread = data.threads.find(t => t.name === 'GeckoMain' || t.isMainThread);
if (!mainThread) {
    console.log("No main thread found");
    process.exit(1);
}

// In Firefox profiler format, threads usually have "samples" which contains stack traces
console.log("Analyzing main thread: " + mainThread.name);

// 1. Let's look at the markers for long frames/tasks
if (mainThread.markers && mainThread.markers.data) {
    const markers = mainThread.markers;
    console.log(`Found ${markers.data.length} markers`);
    
    // Schema is often implicit. Usually [nameIndex, startTime, endTime, phase, category]
    // Let's find the longest markers
    const nameTable = data.shared && data.shared.stringTable ? data.shared.stringTable : markers.name;
    
    const parsedMarkers = [];
    for (let i = 0; i < markers.length; i++) {
        // Different profiler versions have different marker formats. 
        // We will just try to find duration if it's stored as arrays of arrays
        if (Array.isArray(markers.data[i]) && markers.data[i].length >= 3) {
            const start = markers.data[i][1];
            const end = markers.data[i][2];
            if (typeof start === 'number' && typeof end === 'number') {
                const nameIdx = markers.data[i][0];
                const name = Array.isArray(nameTable) ? nameTable[nameIdx] : nameIdx;
                parsedMarkers.push({
                    name,
                    duration: end - start,
                    start,
                    end
                });
            }
        }
    }
    
    if (parsedMarkers.length > 0) {
        parsedMarkers.sort((a, b) => b.duration - a.duration);
        console.log("\nTop 10 Longest Markers:");
        parsedMarkers.slice(0, 10).forEach(m => {
            console.log(`- ${m.name}: ${m.duration.toFixed(2)}ms (Start: ${m.start.toFixed(2)}ms)`);
        });
    } else {
        console.log("Could not parse marker durations based on assumed schema.");
        if (markers.data.length > 0) console.log("Sample marker: ", markers.data[0]);
    }
}

// 2. Let's analyze the call tree / samples if possible
if (mainThread.samples && mainThread.samples.data) {
    console.log(`\nFound ${mainThread.samples.data.length} samples`);
    
    // In Firefox profiles, samples often refer to a stack table, which refers to a frame table, which refers to a string table.
    const stackTable = mainThread.stackTable;
    const frameTable = mainThread.frameTable;
    const stringTable = data.shared ? data.shared.stringTable : mainThread.stringTable;
    
    if (stackTable && frameTable && stringTable) {
        // Count samples per stack to find hotspots
        const stackCounts = {};
        for (let i = 0; i < mainThread.samples.data.length; i++) {
            const sample = mainThread.samples.data[i];
            // Usually sample is [stackId, time]
            const stackId = sample[0];
            if (stackId !== undefined) {
                stackCounts[stackId] = (stackCounts[stackId] || 0) + 1;
            }
        }
        
        // Let's resolve the top stacks
        const sortedStacks = Object.keys(stackCounts).map(Number).sort((a, b) => stackCounts[b] - stackCounts[a]);
        
        console.log("\nTop 10 Call Stacks (by sample count):");
        
        function resolveStack(stackId) {
            const frames = [];
            let currentStack = stackId;
            while (currentStack !== null && currentStack !== undefined) {
                // stackTable is usually { frame: [], prefix: [] }
                const frameId = stackTable.frame[currentStack];
                const prefixId = stackTable.prefix[currentStack];
                
                if (frameId !== undefined && frameId !== null) {
                    // frameTable is usually { string: [], ... }
                    const stringId = frameTable.string[frameId];
                    const funcName = stringTable[stringId];
                    frames.push(funcName);
                }
                
                currentStack = prefixId;
            }
            return frames;
        }
        
        for (let i = 0; i < Math.min(10, sortedStacks.length); i++) {
            const stackId = sortedStacks[i];
            const count = stackCounts[stackId];
            const frames = resolveStack(stackId);
            console.log(`- [${count} samples] ${frames.slice(0, 3).join(' <- ')} ${frames.length > 3 ? '<- ...' : ''}`);
        }
    } else {
        console.log("Could not find stackTable, frameTable, or stringTable to resolve samples.");
    }
}
