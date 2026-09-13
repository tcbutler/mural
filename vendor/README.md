# Vendored browser libraries

The web UI used to load these four things from the internet at page load:

    code.jquery.com        jquery-3.6.0.min.js
    cdnjs.cloudflare.com   jquery.ba-throttle-debounce.min.js
    cdnjs.cloudflare.com   paper.js/0.12.17/paper-full.min.js
    cdn.jsdelivr.net       less

A plotter on a wall is reachable on the LAN long before it is reachable through
a working internet connection, and when a CDN did not answer the page rendered
as a single "Mural" link and nothing else - jQuery undefined, paper undefined,
not one screen shown. The render worker was worse: it called importScripts()
against cdnjs at runtime, so even a fully loaded UI could not trace an image
offline.

`less` is gone rather than vendored: it existed only to compile `styles/dpad.less`
in the browser, which build.py now does at build time.

The rest live here, and build.py gzips them into the filesystem image. Serving
`.gz` is transparent - ESPAsyncWebServer's static handler looks for `<path>.gz`
before `<path>` (AsyncStaticWebHandler::_searchFile) and sets Content-Encoding
itself. Uncompressed they are 325KB against a 451KB filesystem reserve, so
gzipping is what makes them fit at all: 114KB.

## Provenance

    jquery.min.js                       https://code.jquery.com/jquery-3.6.0.min.js
    jquery.ba-throttle-debounce.min.js  https://cdnjs.cloudflare.com/ajax/libs/jquery-throttle-debounce/1.1/jquery.ba-throttle-debounce.min.js
    paper-full.min.js                   https://cdnjs.cloudflare.com/ajax/libs/paper.js/0.12.17/paper-full.min.js

paper-full.min.js was checked against the Subresource Integrity hash that was
already in index.html before it was vendored, and matches exactly:

    sha512-NApOOz1j2Dz1PKsIvg1hrXLzDFd62+J0qOPIhm8wueAnk4fQdSclq6XvfzvejDs6zibSoDC+ipl1dC66m+EoSQ==

## The rule these exist to satisfy

`tools/check_offline.py` fails the build if anything under `data/www` (or these
files) references an external host. It runs from build.py, so a filesystem image
that needs the internet cannot be flashed.
