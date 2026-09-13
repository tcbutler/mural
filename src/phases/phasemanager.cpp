#include "phasemanager.h"
#include "retractbeltsphase.h"
#include "settopdistancephase.h"
#include "extendtohomephase.h"
#include "pencalibrationphase.h"
#include "svgselectphase.h"
#include "begindrawingphase.h"
#include "drawingphase.h"
#include "resumedrawingphase.h"
#include "AsyncJson.h"
#include "ArduinoJson.h"
#include "../prefskeys.h"
#include <Preferences.h>
#include <LittleFS.h>
#include <stdexcept>
#include <cstring>

PhaseManager::PhaseManager(Movement* movement, Pen* pen, Runner* runner, NetWatch* netWatch) {
    this->netWatch = netWatch;
    retractBeltsPhase = new RetractBeltsPhase(this, movement);
    setTopDistancePhase = new SetTopDistancePhase(this, movement, pen);
    extendToHomePhase = new ExtendToHomePhase(this, movement, runner);
    penCalibrationPhase = new PenCalibrationPhase(this, pen);
    svgSelectPhase = new SvgSelectPhase(this);
    beginDrawingPhase = new BeginDrawingPhase(this, runner);
    drawingPhase = new DrawingPhase(this, runner);
    resumeDrawingPhase = new ResumeDrawingPhase(this, movement, pen);

    this->movement = movement;
    this->pen = pen;
    reset();
}

Phase* PhaseManager::getCurrentPhase() {
    return currentPhase;
}

void PhaseManager::setPhase(PhaseNames name) {
    Serial.print("Switching current phase to ");
    switch (name) {
        case PhaseNames::RetractBelts:
            Serial.println("RetractBelts");
            currentPhase = retractBeltsPhase;
            break;
        case PhaseNames::SetTopDistance:
            Serial.println("SetTopDistance");
            currentPhase = setTopDistancePhase;
            break;
        case PhaseNames::ExtendToHome:
            Serial.println("ExtendToHome");
            currentPhase = extendToHomePhase;
            break;
        case PhaseNames::PenCalibration:
            Serial.println("PenCalibration");
            currentPhase = penCalibrationPhase;
            break;
        case PhaseNames::SvgSelect:
            Serial.println("SvgSelect");
            currentPhase = svgSelectPhase;
            break;
        case PhaseNames::BeginDrawing:
            Serial.println("BeginDrawing");
            currentPhase = beginDrawingPhase;
            break;
        case PhaseNames::Drawing:
            Serial.println("Drawing");
            currentPhase = drawingPhase;
            break;
        case PhaseNames::ResumeDrawing:
            Serial.println("ResumeDrawing");
            currentPhase = resumeDrawingPhase;
            break;
        default:
            throw std::invalid_argument("Invalid Phase");
    }
}

const char* PhaseManager::getUploadError() {
    return svgSelectPhase->getUploadError();
}

void PhaseManager::respondWithState(AsyncWebServerRequest *request) {
    auto currentPhase = getCurrentPhase()->getName();
    auto moving = movement->isMoving();
    auto startedHoming = movement->hasStartedHoming();
    auto homePosition = movement->getHomeCoordinates();

    auto topDistance = movement->getTopDistance();
    double widthValue;
    auto safeWidth = movement->getWidth(widthValue) ? widthValue : -1;

    // Values persisted in NVS survive firmware restarts even though the
    // in-memory movement/pen state above does not. Exposing them separately
    // lets the UI prefill the distance input and pen slider with the last
    // known-good calibration instead of forcing the user to redo it.
    Preferences prefs;
    prefs.begin(PREFS_NAMESPACE, true);
    int storedTopDistance = prefs.getInt(PREFS_TOP_DISTANCE_KEY, -1);
    int storedPenAngle = prefs.getInt(PREFS_PEN_ANGLE_KEY, -1);
    prefs.end();

    // While a resume-after-power-loss offer is pending/in-progress (see reset()),
    // let the UI show what fraction of the job was already completed.
    int resumePercent = -1;
    if (resuming) {
        int totalLines = Runner::countTotalCommandLines();
        resumePercent = totalLines > 0 ? (pendingCheckpoint.executedLines * 100) / totalLines : 0;
        if (resumePercent > 100) {
            resumePercent = 100;
        }
    }

    AsyncResponseStream *response = request->beginResponseStream("application/json");
    DynamicJsonBuffer jsonBuffer;
    JsonObject &root = jsonBuffer.createObject();

    root["phase"] = currentPhase;
    root["moving"] = moving;
    // Whether a homing/extend move has been commanded. Read but never sent: the
    // UI's ExtendToHome branch restores the spinner from state.startedHoming, so
    // without this a page refresh mid-extend showed an idle, enabled button, and
    // a second press would re-run setOrigin() in the middle of the travel - which
    // re-zeros the belt position and loses the machine's idea of where it is.
    root["startedHoming"] = startedHoming;
    // Link health, so "the web UI won't load" can be answered with a number
    // instead of a guess. rssi is dBm (roughly: -50 excellent, -70 usable, -80
    // and below is where this machine started dropping packets); wifiReconnects
    // counts drops recovered since boot.
    root["rssi"] = netWatch->getRssi();
    root["wifiReconnects"] = netWatch->getReconnects();
    // Free heap, and the largest single block of it. Measured serving the UI on
    // a device that had been up an hour: 165KB of worker.js came down at 20KB/s,
    // index.html managed 4,129 of 44,172 bytes in 30 seconds (137 B/s) and
    // then stalled, and OTA died partway. Small requests stayed fine
    // throughout, which is what a starved or fragmented heap looks like from
    // the outside - AsyncTCP cannot get buffers, so anything sustained crawls.
    // largestFreeBlock matters as much as the total: OTA and the async server
    // need contiguous allocations, and fragmentation shows up here first.
    root["freeHeap"] = ESP.getFreeHeap();
    root["largestFreeBlock"] = ESP.getMaxAllocHeap();
    root["uptimeSeconds"] = millis() / 1000;
    root["topDistance"] = topDistance;
    root["safeWidth"] = safeWidth;
    root["homeX"] = homePosition.x;
    root["homeY"] = homePosition.y;
    root["storedTopDistance"] = storedTopDistance;
    root["storedPenAngle"] = storedPenAngle;
    root["uploadCrc32"] = svgSelectPhase->getUploadCrc32();
    // Whether /commands holds a previously plotted file, so the UI can offer to
    // re-plot it instead of making the user re-upload. Survives the restart that
    // follows every plot; uploadCrc32 does not, being in-memory.
    root["hasCommands"] = LittleFS.exists("/commands");
    // Calibrated pen-holder geometry (see prefskeys.h). The UI needs these to
    // bound its own sliders: the contact point must stay inside the locked
    // range, and the release position sits above it.
    root["penLowestLocked"] = pen->getLowestLocked();
    root["penHighestLocked"] = pen->getHighestLocked();
    root["penUnlocked"] = pen->getUnlockedAngle();
    // Whether drive current is currently cut so the belts can be pulled by hand
    // (see handleSetMotorsFree). The UI reflects this rather than tracking it
    // locally, so a reload cannot show the wrong state for something physical.
    root["motorsFree"] = movement->areMotorsReleased();
    root["resuming"] = resuming;
    root["resumePercent"] = resumePercent;
    // Multi-color (docs/multi-color.md): which pen was mounted when the
    // checkpointed job was interrupted, so the resume offer can warn the user
    // which pen must be (re-)inserted. resumeColorName is "" for a
    // single-color job/checkpoint (see Runner::writeCheckpoint()) - the UI
    // omits the "pen must be inserted" line entirely in that case.
    if (resuming) {
        root["resumeColorIndex"] = pendingCheckpoint.colorIndex;
        root["resumeColorName"] = pendingCheckpoint.colorName;
    }

#ifdef MURAL_TMC_UART
    root["autoRetract"] = true;
#else
    root["autoRetract"] = false;
#endif

    if (strcmp(currentPhase, "RetractBelts") == 0) {
        root["leftRetract"] = retractBeltsPhase->getLeftStatus();
        root["rightRetract"] = retractBeltsPhase->getRightStatus();
    }

    root.printTo(*response);
    request->send(response);
}

void PhaseManager::reset() {
    Runner::Checkpoint cp;
    if (Runner::loadCheckpoint(cp) && LittleFS.exists("/commands")) {
        pendingCheckpoint = cp;
        resuming = true;
        setPhase(PhaseManager::ResumeDrawing);
    } else {
        resuming = false;
        setPhase(PhaseManager::SetTopDistance);
    }
}

bool PhaseManager::isResuming() {
    return resuming;
}

Runner::Checkpoint PhaseManager::getPendingCheckpoint() {
    return pendingCheckpoint;
}

void PhaseManager::clearResuming() {
    resuming = false;
}
