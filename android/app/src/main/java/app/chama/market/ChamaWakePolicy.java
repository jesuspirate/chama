package app.chama.market;

final class ChamaWakePolicy {
    static boolean fresh(long sentAt, long now) {
        return sentAt > 0 && sentAt <= now && now - sentAt <= 120_000;
    }
    static boolean mayDisplay(boolean enabled, boolean foreground, long lastWake, long now) {
        return enabled && !foreground && now - lastWake >= 5000;
    }
}
