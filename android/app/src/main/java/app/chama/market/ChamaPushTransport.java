package app.chama.market;

/** Sandboxed Play services count: availability, not privileged installation. */
final class ChamaPushTransport {
    static String select(boolean configured, boolean playReachable, boolean firebaseReady, boolean unifiedAvailable) {
        if (configured && playReachable && firebaseReady) return "fcm";
        return unifiedAvailable ? "unifiedpush" : "unavailable";
    }
}
