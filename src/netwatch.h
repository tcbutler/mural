#ifndef NetWatch_h
#define NetWatch_h

#include <Arduino.h>

// --- Staying on the network -------------------------------------------------
//
// WiFiManager::autoConnect() runs once, in setup(), and until now that was the
// entire story: nothing watched the link afterwards, so a drop left the machine
// unreachable until someone power-cycled it. Measured on the bench while
// diagnosing exactly that: 400/909/1411ms round-trips with 33% packet loss,
// then total silence, with the web UI simply never loading.
//
// Two things have to be put back on a reconnect, not one. The station comes back
// on its own (esp_wifi's auto-reconnect, made explicit in begin()), but mDNS does
// not survive re-association: MDNS.begin() was called once at boot, so
// mural.local stops answering even after the IP works again. That asymmetry was
// visible in the same session - the raw IP answered in 0.17s while mural.local
// needed a 5s lookup and then stopped resolving altogether.
//
// Everything here is driven from tick() in loop() rather than from the WiFi
// event callback, which runs on the event task: restarting mDNS from there means
// doing network setup on a stack that is not sized for it.
class NetWatch {
    public:
    // hostname is the mDNS name, without ".local".
    void begin(const char* hostname);
    // Call from loop(). Cheap when the link is healthy.
    void tick();

    bool isConnected() const;
    // Signal strength in dBm, or 0 when disconnected. Roughly: -50 excellent,
    // -70 usable, -80 and below is where this machine started losing packets.
    int getRssi() const;
    uint32_t getReconnects() const { return reconnects; }
    // Seconds the link has currently been down, or 0 while connected. Lets the
    // UI say "Mural is offline" instead of just failing to load.
    uint32_t getDownSeconds() const;

    private:
    const char* hostname = "mural";
    // Set by the WiFi event handler, acted on in tick().
    static volatile bool sawDisconnect;
    static volatile bool sawGotIp;
    uint32_t reconnects = 0;
    unsigned long downSince = 0;
    unsigned long lastReconnectAttempt = 0;

    void restartMdns();
};

#endif
