package app.chama.market;

final class ChamaWakePolicy {
    static boolean fresh(long sentAt, long now) {
        return sentAt > 0 && sentAt <= now && now - sentAt <= 120_000;
    }
    static String verdict(boolean enabled, boolean foreground, boolean notifications, boolean test, long lastPosted, long now) {
        if (!enabled || !notifications) return "notifications-disabled";
        if (!test && foreground) return "foreground";
        if (!test && lastPosted > 0 && now - lastPosted < 5000) return "rate-limited";
        return "shown";
    }
    static String reason(String trade, String tag) {
        String reason = tag.startsWith(trade + ":") ? tag.substring(trade.length() + 1) : tag;
        // Chat event IDs and wake event IDs deduplicate replay, not notification slots.
        if (reason.startsWith("joined:")) return "joined";
        if (reason.startsWith("chat:")) return "chat";
        if (reason.startsWith("wake:")) return reason.split(":")[1];
        return reason;
    }
    static boolean replacesState(String trade, String tag, String group) {
        return !trade.isEmpty() && group.isEmpty() && !reason(trade, tag).equals("chat");
    }
    static int notificationId(String trade, String tag) {
        return (trade + ":" + reason(trade, tag)).hashCode();
    }
}
