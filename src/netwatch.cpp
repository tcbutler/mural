#include "netwatch.h"

#include <WiFi.h>
#include <ESPmDNS.h>

// The OTA listener's port, re-advertised alongside mural.local after a
// reconnect. ArduinoOTA::begin() registers this itself at boot but is guarded by
// an _initialized flag, so calling it again is a no-op - the service has to be
// re-registered here instead, or wireless updates stop being discoverable even
// though the device is back.
static const uint16_t OTA_PORT = 3232;

// How long to leave the station's own retry logic to it before nudging it.
static const unsigned long RECONNECT_INTERVAL_MS = 10000;

volatile bool NetWatch::sawDisconnect = false;
volatile bool NetWatch::sawGotIp = false;

void NetWatch::begin(const char* hostname) {
    this->hostname = hostname;

    // Explicit rather than relying on the core's default, which has changed
    // between Arduino-ESP32 versions.
    WiFi.setAutoReconnect(true);

    WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t info) {
        sawDisconnect = true;
    }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);

    WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t info) {
        sawGotIp = true;
    }, ARDUINO_EVENT_WIFI_STA_GOT_IP);
}

void NetWatch::tick() {
    if (sawDisconnect) {
        sawDisconnect = false;
        if (downSince == 0) {
            downSince = millis();
            Serial.println("WiFi disconnected - waiting for it to come back");
        }
    }

    if (sawGotIp) {
        sawGotIp = false;
        // Only count it as a reconnect if we had actually noticed it go away;
        // the first GOT_IP of the session is just the boot-time connection.
        if (downSince != 0) {
            reconnects++;
            downSince = 0;
            Serial.print("WiFi back after a drop (reconnect #");
            Serial.print(reconnects);
            Serial.print("), IP ");
            Serial.println(WiFi.localIP());
        }
        restartMdns();
    }

    // Nudge the station if it has been down a while. WiFi.reconnect() is
    // harmless when a reconnect is already in flight, and the interval keeps
    // this from thrashing the radio.
    if (downSince != 0 && (millis() - lastReconnectAttempt) > RECONNECT_INTERVAL_MS) {
        lastReconnectAttempt = millis();
        Serial.println("Still offline - retrying WiFi");
        WiFi.reconnect();
    }
}

// mDNS does not survive a re-association: the responder keeps its old socket
// state and mural.local silently stops answering while the IP still works.
// Tearing it down and starting it again is the only reliable way back.
void NetWatch::restartMdns() {
    MDNS.end();
    if (MDNS.begin(hostname)) {
        MDNS.enableArduino(OTA_PORT);
        Serial.print("mDNS re-announced as ");
        Serial.print(hostname);
        Serial.println(".local");
    } else {
        Serial.println("mDNS restart failed");
    }
}

bool NetWatch::isConnected() const {
    return WiFi.status() == WL_CONNECTED;
}

int NetWatch::getRssi() const {
    return isConnected() ? WiFi.RSSI() : 0;
}

uint32_t NetWatch::getDownSeconds() const {
    if (downSince == 0) {
        return 0;
    }
    return (millis() - downSince) / 1000;
}
