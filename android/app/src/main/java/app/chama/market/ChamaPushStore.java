package app.chama.market;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Device-local opaque endpoints/tags only. Never receives keys or trade bodies. */
final class ChamaPushStore {
    static volatile boolean foreground;
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();
    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("chama_push", Context.MODE_PRIVATE); }
    static boolean enabled(Context c) { return prefs(c).getBoolean("enabled", false); }

    static synchronized void endpoint(Context c, JSONObject endpoint) {
        if (!enabled(c)) return;
        String old = prefs(c).getString("endpoint", "");
        String next = endpoint.toString();
        String tags = prefs(c).getString("tags", "[]");
        prefs(c).edit().putString("endpoint", next).apply();
        if (!old.isEmpty() && !old.equals(next)) send(c, "unregister", old, tags);
        send(c, "register", next, tags);
    }

    static synchronized void tags(Context c, JSONArray incoming, boolean add) throws Exception {
        JSONArray previous = new JSONArray(prefs(c).getString("tags", "[]"));
        java.util.LinkedHashSet<String> merged = new java.util.LinkedHashSet<>();
        for (int i = 0; i < previous.length(); i++) merged.add(previous.getString(i));
        for (int i = 0; i < incoming.length(); i++) {
            String tag = incoming.getString(i);
            if (!tag.matches("[A-Za-z0-9_-]{1,64}")) throw new IllegalArgumentException("Invalid wake tag");
            if (add) merged.add(tag); else merged.remove(tag);
        }
        if (merged.size() > 200) throw new IllegalArgumentException("Too many wake tags");
        String endpoint = prefs(c).getString("endpoint", "");
        String tags = new JSONArray(merged).toString();
        prefs(c).edit().putString("tags", tags).apply();
        // Retry the complete desired registration on each foreground update.
        send(c, add ? "register" : "unregister", endpoint, add ? tags : incoming.toString());
    }

    static synchronized void disable(Context c) {
        String endpoint = prefs(c).getString("endpoint", "");
        String tags = prefs(c).getString("tags", "[]");
        prefs(c).edit().clear().apply();
        send(c, "unregister", endpoint, tags);
        NotificationManagerCompat.from(c).cancel(6501);
    }

    static void retry(Context c) {
        if (enabled(c)) send(c, "register", prefs(c).getString("endpoint", ""), prefs(c).getString("tags", "[]"));
    }

    private static void send(Context c, String action, String endpoint, String tags) {
        if (endpoint.isEmpty() || tags.equals("[]")) return;
        IO.execute(() -> {
            HttpURLConnection conn = null;
            try {
                JSONObject body = new JSONObject().put("endpoint", new JSONObject(endpoint)).put("tags", new JSONArray(tags));
                conn = (HttpURLConnection) new URL("https://push.chama.community/" + action).openConnection();
                conn.setConnectTimeout(5000); conn.setReadTimeout(5000);
                conn.setInstanceFollowRedirects(false);
                conn.setRequestMethod("POST"); conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                try (var out = conn.getOutputStream()) { out.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
                int code = conn.getResponseCode();
                prefs(c).edit().putBoolean("registered", code >= 200 && code < 300 && action.equals("register")).apply();
            } catch (Exception ignored) {
                prefs(c).edit().putBoolean("registered", false).apply();
            } finally { if (conn != null) conn.disconnect(); }
        });
    }

    /** An opaque wake promises no outcome. Opening the app replays signed state. */
    static synchronized void wake(Context c) {
        long now = System.currentTimeMillis();
        if (!ChamaWakePolicy.mayDisplay(enabled(c), foreground, prefs(c).getLong("lastWake", 0), now)) return;
        if (!NotificationManagerCompat.from(c).areNotificationsEnabled()) return;
        NotificationManager manager = c.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("chama_activity", "Chama", NotificationManager.IMPORTANCE_DEFAULT));
        PendingIntent open = PendingIntent.getActivity(c, 6501,
            new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        try {
            NotificationManagerCompat.from(c).notify(6501, new NotificationCompat.Builder(c, "chama_activity")
                .setSmallIcon(R.drawable.ic_chama_notification).setContentTitle("Chama")
                .setContentText(c.getString(R.string.push_activity)).setContentIntent(open)
                .setAutoCancel(true).setOnlyAlertOnce(true).build());
            prefs(c).edit().putLong("lastWake", now).apply();
        } catch (SecurityException ignored) { /* OS permission can change at any time. */ }
    }
}
