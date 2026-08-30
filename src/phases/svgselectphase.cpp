#include "svgselectphase.h"
#include "LittleFS.h"
#include "../crc32.h"
#include "../runner.h"

SvgSelectPhase::SvgSelectPhase(PhaseManager* manager) {
    this->manager = manager;
}

void SvgSelectPhase::handleUpload(AsyncWebServerRequest *request, String filename, size_t index, uint8_t *data, size_t len, bool final)
{
    if (!index)
    {
        uploadFailed = false;
        uploadError = nullptr;
        uploadBytesWritten = 0;

        // Upload into a temp file and swap it into place only once it is whole.
        // Deleting /commands up front meant a failed upload destroyed the file
        // the user already had, costing them the previous plot as well as the new
        // one - and taking "Plot the image already on Mural" with it.
        if (LittleFS.exists(UPLOAD_TEMP_PATH)) {
            LittleFS.remove(UPLOAD_TEMP_PATH);
        }

        const size_t freeBytes = LittleFS.totalBytes() - LittleFS.usedBytes();
        Serial.printf("Upload: %u bytes free, incoming %u bytes\n",
                      (unsigned)freeBytes, (unsigned)request->contentLength());

        if (freeBytes < request->contentLength()) {
            uploadFailed = true;
            uploadError = "Not enough space on Mural for this drawing";
            Serial.println("Upload rejected: not enough space");
            return;
        }

        request->_tempFile = LittleFS.open(UPLOAD_TEMP_PATH, "w");
        if (!request->_tempFile) {
            uploadFailed = true;
            uploadError = "Could not open the command file for writing";
            Serial.println("Upload rejected: could not open temp file");
            return;
        }

        crcState = crc32_init();
        Serial.println("Upload started");
    }

    // Every remaining chunk of a rejected upload arrives here too - without this
    // they would write to a File that was never opened and feed CRC state that
    // was never initialised, then report that garbage as a successful upload.
    if (uploadFailed) {
        return;
    }

    if (len)
    {
        // A short write means the filesystem filled mid-stream. Unchecked, that
        // produced a truncated file whose CRC still matched, because the CRC came
        // from the incoming bytes rather than the stored ones.
        const size_t written = request->_tempFile.write(data, len);
        if (written != len) {
            uploadFailed = true;
            uploadError = "Ran out of space while saving the drawing";
            Serial.printf("Upload failed: wrote %u of %u bytes\n", (unsigned)written, (unsigned)len);
            request->_tempFile.close();
            LittleFS.remove(UPLOAD_TEMP_PATH);
            return;
        }
        uploadBytesWritten += written;
        crcState = crc32_update(crcState, data, len);
    }

    if (final)
    {
        request->_tempFile.close();

        // Check what actually landed on disk. The streaming CRC proves the bytes
        // arrived intact over the network but says nothing about whether they
        // were stored; comparing the stored size catches the truncation a full
        // filesystem produces. A full re-read and CRC would be stronger, but it
        // blocks the async server task for the length of the file, on a device
        // that already struggles with large uploads.
        File stored = LittleFS.open(UPLOAD_TEMP_PATH, "r");
        const size_t storedSize = stored ? stored.size() : 0;
        if (stored) {
            stored.close();
        }

        if (storedSize != uploadBytesWritten) {
            uploadFailed = true;
            uploadError = "The drawing did not save correctly to Mural";
            Serial.printf("Upload failed: stored %u bytes, expected %u\n",
                          (unsigned)storedSize, (unsigned)uploadBytesWritten);
            LittleFS.remove(UPLOAD_TEMP_PATH);
            return;
        }

        // Only now is the previous command file replaced.
        if (LittleFS.exists("/commands")) {
            LittleFS.remove("/commands");
        }
        if (!LittleFS.rename(UPLOAD_TEMP_PATH, "/commands")) {
            uploadFailed = true;
            uploadError = "Could not store the drawing on Mural";
            Serial.println("Upload failed: rename into place failed");
            LittleFS.remove(UPLOAD_TEMP_PATH);
            return;
        }

        // The new job invalidates any checkpoint from the previous one. Done here
        // rather than at the start of the upload, so a failed upload leaves a
        // resumable job resumable.
        Runner::clearCheckpoint();

        lastUploadCrc32 = crc32_finalize(crcState);
        Serial.printf("Upload finished: %u bytes, CRC32 %08X\n",
                      (unsigned)uploadBytesWritten, lastUploadCrc32);
        manager->setPhase(PhaseManager::RetractBelts);
    }
}

void SvgSelectPhase::installTestPattern(AsyncWebServerRequest *request) {
    if (!LittleFS.exists("/calibrationPattern.txt")) {
        request->send(404, "text/plain", "Calibration pattern asset missing");
        return;
    }

    if (LittleFS.exists("/commands")) {
        LittleFS.remove("/commands");
    }

    // Installing the test pattern is also a new job - invalidate any old checkpoint.
    Runner::clearCheckpoint();

    File source = LittleFS.open("/calibrationPattern.txt", "r");
    File dest = LittleFS.open("/commands", "w");

    uint8_t buffer[512];
    while (source.available()) {
        size_t bytesRead = source.read(buffer, sizeof(buffer));
        dest.write(buffer, bytesRead);
    }

    source.close();
    dest.close();

    Serial.println("Installed calibration test pattern");
    manager->setPhase(PhaseManager::RetractBelts);
    manager->respondWithState(request);
}

// Re-plot whatever is already in /commands. Mural restarts after every plot
// (Runner::getNextTask), which drops all in-memory state but not LittleFS - so
// the file that was just drawn is still there, and re-uploading it to draw it
// again is pure waste. The belts still have to be re-homed, which is why this
// advances to RetractBelts exactly like a fresh upload rather than jumping
// straight to drawing.
void SvgSelectPhase::useStoredCommands(AsyncWebServerRequest *request) {
    if (!LittleFS.exists("/commands")) {
        request->send(404, "text/plain", "No command file stored");
        return;
    }

    // A re-plot is a new job, so any checkpoint from the previous run is stale.
    Runner::clearCheckpoint();

    Serial.println("Re-plotting the stored command file");
    manager->setPhase(PhaseManager::RetractBelts);
    manager->respondWithState(request);
}

const char* SvgSelectPhase::getName() {
    return "SvgSelect";
}

uint32_t SvgSelectPhase::getUploadCrc32() {
    return lastUploadCrc32;
}