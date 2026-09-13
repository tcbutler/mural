import paper from 'paper';
import { env } from 'process';

let loaded = false;
export function loadPaper(): paper.PaperScope {
    if (env && env["server"]) {
        const paperModule = require("paper");
        return paperModule;
    } else {
        if (!loaded) {
            // Relative to the worker's own URL (/www/worker/worker.js), so this
            // resolves to /www/vendor/paper-full.min.js - served by the plotter.
            // This used to fetch cdnjs at runtime, which meant an image could
            // fail to render offline long after the page itself had loaded fine.
            importScripts("../vendor/paper-full.min.js");
            (self.paper as any as paper.PaperScope).install(self);
            loaded = true;
        }
    
        return self.paper as any as paper.PaperScope;
    }
    
}