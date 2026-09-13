#ifndef SvgSelectPhase_h
#define SvgSelectPhase_h
#include "notsupportedphase.h"
#include "phasemanager.h"
class SvgSelectPhase : public NotSupportedPhase {
    private:
    PhaseManager* manager;
    uint32_t crcState;
    uint32_t lastUploadCrc32 = 0;

    // Upload failure state. AsyncWebServer keeps calling handleUpload() for
    // every remaining chunk after a failure - returning early only ends that one
    // callback - so the failure has to be remembered and every later chunk
    // skipped, or a rejected upload carries on writing to an unopened file and
    // accumulating CRC from uninitialised state.
    bool uploadFailed = false;
    const char* uploadError = nullptr;
    size_t uploadBytesWritten = 0;

    // Uploads land here and are renamed into place only once complete, so a
    // failed upload cannot destroy the command file already on the device.
    static constexpr const char* UPLOAD_TEMP_PATH = "/commands.part";
    public:
    SvgSelectPhase(PhaseManager* manager);
    void handleUpload(AsyncWebServerRequest *request, String filename, size_t index, uint8_t *data, size_t len, bool final);
    void installTestPattern(AsyncWebServerRequest *request);
    void useStoredCommands(AsyncWebServerRequest *request);
    const char* getName();
    // CRC32 of the most recently completed upload, streamed incrementally while
    // the file was written to LittleFS. Used by the client to verify the upload
    // without re-downloading and diffing the whole file.
    uint32_t getUploadCrc32();
    // Non-null when the last upload failed; the reason to report to the client.
    const char* getUploadError() { return uploadFailed ? uploadError : nullptr; }
};
#endif