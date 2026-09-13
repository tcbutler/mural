import gzip
import os
import shutil
import subprocess
import sys

Import("env")

PROJECT = os.getcwd()
STAGING = os.path.join(PROJECT, ".pio", "wwwdist")

# Assets are gzipped into the filesystem image. ESPAsyncWebServer's static
# handler looks for "<path>.gz" before "<path>" and sets Content-Encoding itself
# (AsyncStaticWebHandler::_searchFile), so nothing on the device or in the UI has
# to know. It is worth it twice over: a page load drops from ~400KB to ~115KB
# over a WiFi link that has been measured at 400-1400ms round-trips, and the
# vendored libraries do not fit in the filesystem reserve uncompressed.
#
# Only text compresses usefully; anything else is copied through.
COMPRESSIBLE = {".html", ".js", ".mjs", ".css", ".json", ".svg", ".txt", ".map"}

# Files that exist to be built from, not shipped.
SKIP_NAMES = {".DS_Store"}
# .less is a build input; .md is documentation that lives beside the vendored
# libraries (vendor/README.md) and has no business on the device.
SKIP_SUFFIXES = {".less", ".md"}


def run(command, cwd=None):
    print("  " + " ".join(command))
    result = subprocess.run(command, cwd=cwd)
    if result.returncode != 0:
        print("Build step failed: " + " ".join(command))
        env.Exit(1)


print("Transpiling TS code")
shutil.rmtree(os.path.join(PROJECT, "data", "www", "worker"), ignore_errors=True)
os.makedirs(os.path.join(PROJECT, "data", "www", "worker"), exist_ok=True)
run(["npm", "run", "build"], cwd=os.path.join(PROJECT, "tsc"))
shutil.copyfile(
    os.path.join(PROJECT, "tsc", "dist_packed", "main.js"),
    os.path.join(PROJECT, "data", "www", "worker", "worker.js"),
)

print("Compiling dpad.less")
# Was compiled in the browser by less.js, pulled from a CDN on every page load -
# 230KB of JavaScript, an internet dependency, and a compile on the phone, to
# produce 5KB of CSS that never changes between flashes.
lessc = os.path.join(PROJECT, "tsc", "node_modules", ".bin", "lessc")
if not os.path.exists(lessc):
    run(["npm", "install", "--no-save", "less"], cwd=os.path.join(PROJECT, "tsc"))
run([lessc, os.path.join("styles", "dpad.less"), os.path.join("data", "www", "dpad.css")])

# Deliberately after the worker bundle and the CSS are generated, and before
# anything is packed: those are the files being shipped, and the first version of
# this ran ahead of the TS build, where it was checking the *previous* build's
# worker.js. A filesystem image that needs the internet must not be buildable,
# let alone flashable. See tools/check_offline.py.
print("Checking the UI needs no internet")
run([sys.executable, os.path.join("tools", "check_offline.py")])

print("Assembling the filesystem image")
shutil.rmtree(STAGING, ignore_errors=True)
staged_www = os.path.join(STAGING, "www")
os.makedirs(staged_www, exist_ok=True)

raw_bytes = 0
packed_bytes = 0


def stage(source_root, destination_root):
    global raw_bytes, packed_bytes
    for directory, _, files in os.walk(source_root):
        for name in files:
            if name in SKIP_NAMES:
                continue
            source = os.path.join(directory, name)
            suffix = os.path.splitext(name)[1].lower()
            if suffix in SKIP_SUFFIXES:
                continue

            relative = os.path.relpath(source, source_root)
            destination = os.path.join(destination_root, relative)
            os.makedirs(os.path.dirname(destination), exist_ok=True)

            size = os.path.getsize(source)
            raw_bytes += size
            if suffix in COMPRESSIBLE:
                with open(source, "rb") as handle:
                    payload = handle.read()
                # mtime=0 keeps the image byte-stable between builds of identical
                # input, so an unchanged UI does not look like a changed one.
                with gzip.GzipFile(destination + ".gz", "wb", compresslevel=9, mtime=0) as out:
                    out.write(payload)
                packed_bytes += os.path.getsize(destination + ".gz")
            else:
                shutil.copyfile(source, destination)
                packed_bytes += size


stage(os.path.join(PROJECT, "data", "www"), staged_www)
stage(os.path.join(PROJECT, "vendor"), os.path.join(staged_www, "vendor"))

print("  %s -> %s bytes (%.0f%% smaller)" % (
    format(raw_bytes, ","), format(packed_bytes, ","),
    100 * (1 - packed_bytes / raw_bytes) if raw_bytes else 0,
))
