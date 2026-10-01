package app.chama.market;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.app.NotificationManagerCompat;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Device-local registration, replay diagnostics and notification delivery. */
final class ChamaPushStore {
    // Written by activity lifecycle callbacks; cold pushes never wait for WebView startup.
    static volatile boolean activityStarted = false;
    static volatile String foregroundBranch = "no activity";
    static boolean foreground() { return activityStarted; }

    static synchronized JSONArray alertLog(Context c) {
        try { return new JSONArray(prefs(c).getString("alertLog", "[]")); }
        catch (Exception e) { return new JSONArray(); }
    }
    static synchronized String beginWake(Context c, String transport) {
        String id = java.util.UUID.randomUUID().toString();
        try {
            JSONArray rows = alertLog(c), bounded = new JSONArray();
            for (int i = Math.max(0, rows.length() - 49); i < rows.length(); i++) bounded.put(rows.get(i));
            bounded.put(new JSONObject().put("id", id).put("time", System.currentTimeMillis())
                .put("transport", transport).put("verdict", "pending").put("job", "queued")
                .put("foregroundBranch", foregroundBranch).put("posts", new JSONArray()));
            prefs(c).edit().putString("alertLog", bounded.toString()).apply();
        } catch (Exception ignored) { }
        return id;
    }
    static synchronized void log(Context c, String wake, String verdict, String job, Integer postedId, String reason) {
        try {
            JSONArray rows = alertLog(c);
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row = rows.getJSONObject(i);
                if (!wake.equals(row.optString("id"))) continue;
                if (verdict != null) row.put("verdict", verdict);
                if (job != null) row.put("job", job);
                if (reason != null) row.getJSONArray("posts").put(new JSONObject().put("reason", reason)
                    .put("verdict", verdict).put("notificationId", postedId == null ? JSONObject.NULL : postedId));
                row.put("notificationsEnabled", NotificationManagerCompat.from(c).areNotificationsEnabled());
                row.put("channelEnabled", channelEnabled(c));
                row.put("foregroundBranch", foregroundBranch);
            }
            prefs(c).edit().putString("alertLog", rows.toString()).apply();
        } catch (Exception ignored) { }
    }
    static synchronized void jobDetails(Context c, String wake, JSONArray tags, String result, long elapsedMs) {
        try {
            JSONArray rows = alertLog(c);
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row = rows.getJSONObject(i);
                if (!wake.equals(row.optString("id"))) continue;
                if (tags != null) row.put("matchedTags", tags);
                if (result != null) row.put("jobResult", result);
                row.put("elapsedMs", elapsedMs);
            }
            prefs(c).edit().putString("alertLog", rows.toString()).apply();
        } catch (Exception ignored) { }
    }
    static synchronized void tradeCount(Context c, String wake, int count) {
        try {
            JSONArray rows = alertLog(c);
            for (int i = 0; i < rows.length(); i++) if (wake.equals(rows.getJSONObject(i).optString("id"))) rows.getJSONObject(i).put("tradeCount", count);
            prefs(c).edit().putString("alertLog", rows.toString()).apply();
        } catch (Exception ignored) { }
    }
    static boolean channelEnabled(Context c) {
        if (android.os.Build.VERSION.SDK_INT < 26) return true;
        NotificationChannel channel = c.getSystemService(NotificationManager.class).getNotificationChannel("chama_activity");
        return channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }
    static String policy(Context c, boolean test, long lastPosted) {
        return ChamaWakePolicy.verdict(enabled(c), !test && foreground(),
            NotificationManagerCompat.from(c).areNotificationsEnabled() && channelEnabled(c),
            test, lastPosted, System.currentTimeMillis());
    }
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
        for (String key : prefs(c).getAll().keySet()) {
            if (key.startsWith("posted:")) {
                try { NotificationManagerCompat.from(c).cancel(Integer.parseInt(key.substring(7))); }
                catch (NumberFormatException ignored) { }
            }
        }
        String log = alertLog(c).toString();
        String lane = prefs(c).getString("lane", "");
        prefs(c).edit().clear().putString("alertLog", log)
            .putString("endpoint", endpoint).putString("lane", lane).apply();
        send(c, "unregister", endpoint, tags);
        NotificationManagerCompat.from(c).cancel(6501);
    }

    static void retry(Context c) {
        if (enabled(c)) send(c, "register", prefs(c).getString("endpoint", ""), prefs(c).getString("tags", "[]"));
    }

    private static void send(Context c, String action, String endpoint, String tags) {
        if (endpoint.isEmpty()) return;
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
                SharedPreferences.Editor registration = prefs(c).edit().putInt("registerHttpStatus", code).putBoolean("registered", code >= 200 && code < 300 && action.equals("register"));
                if (code >= 200 && code < 300 && action.equals("register")) registration.putString("registeredTags", tags);
                registration.apply();
            } catch (Exception ignored) {
                prefs(c).edit().putInt("registerHttpStatus", 0).putBoolean("registered", false).apply();
            } finally { if (conn != null) conn.disconnect(); }
        });
    }

    static void test(Context c, String nonce) {
        String wake = beginWake(c, prefs(c).getString("lane", ""));
        IO.execute(() -> {
            HttpURLConnection conn = null;
            try {
                JSONObject endpoint = new JSONObject(prefs(c).getString("endpoint", ""));
                JSONObject body = new JSONObject().put("endpoint", endpoint).put("nonce", nonce);
                conn = (HttpURLConnection) new URL("https://push.chama.community/test").openConnection();
                conn.setConnectTimeout(5000); conn.setReadTimeout(20000);
                conn.setInstanceFollowRedirects(false);
                conn.setRequestMethod("POST"); conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                try (var out = conn.getOutputStream()) { out.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
                int code = conn.getResponseCode();
                prefs(c).edit().putInt("testHttpStatus", code).putString("testHttpNonce", nonce).apply();
                log(c, wake, code >= 200 && code < 300 ? "sent" : "failed", "test HTTP " + code, null, null);
                // HTTP success is not delivery; only the receiving service acknowledges it.
            } catch (Exception ignored) {
                prefs(c).edit().putInt("testHttpStatus", 0).putString("testHttpNonce", nonce).apply();
                log(c, wake, "failed", "test network error (no HTTP response)", null, null);
            }
            finally { if (conn != null) conn.disconnect(); }
        });
    }

    static boolean testReply(Context c, String nonce, String transport) {
        if (nonce == null || nonce.isEmpty()) return false;
        String wake = beginWake(c, transport);
        if (enabled(c) && nonce.equals(prefs(c).getString("testPending", ""))) {
            prefs(c).edit().putString("testReceived", nonce).remove("testPending").apply();
            log(c, wake, null, "test received", null, null);
            post(c, wake, "", "test", "Chama", "Test alert from your alert server — alerts reach this phone", true);
        } else log(c, wake, "ignored", "unmatched test reply", null, null);
        return true;
    }

    /** Queue every wake: KEEP would discard changes arriving during an in-flight replay. */
    static void wake(Context c, String transport, JSONArray incoming) {
        wake(c, transport, incoming, beginWake(c, transport));
    }
    static void wake(Context c, String transport, JSONArray incoming, String wake) {
        JSONArray tags = new JSONArray();
        if (incoming != null) {
            if (incoming.length() > 20) return;
            for (int i = 0; i < incoming.length(); i++) {
                String tag = incoming.optString(i);
                if (!tag.matches("[A-Za-z0-9_-]{1,64}")) return;
                tags.put(tag);
            }
        }
        jobDetails(c, wake, tags, "queued", 0);
        String verdict = policy(c, false, 0);
        if (!"shown".equals(verdict)) { log(c, wake, verdict, "not run", null, null); return; }
        ChamaWakeWorker.enqueue(c, wake, tags);
    }

    static String postTrade(Context c, String wake, JSONObject note) throws Exception {
        String trade = note.getString("escrowId");
        if (!trade.matches("(?i)sm_[a-z0-9_]+")) return "invalid";
        return post(c, wake, trade, note.getString("tag"), note.getString("title"), note.getString("body"), false, note.optString("group", ""), note);
    }

    static String postForegroundChat(Context c, String wake, JSONObject note) throws Exception {
        return post(c, wake, note.getString("escrowId"), note.getString("tag"), note.getString("title"),
            note.getString("body"), false, "", note, true);
    }

    static synchronized void clearTrade(Context c, String trade) {
        NotificationManagerCompat manager = NotificationManagerCompat.from(c);
        int state = prefs(c).getInt("tradeNote:" + trade, 0);
        if (state != 0) manager.cancel(state);
        manager.cancel(ChamaWakePolicy.notificationId(trade, trade + ":chat:read"));
        prefs(c).edit().remove("tradeNote:" + trade).remove("tradeChat:" + trade).apply();
    }

    static void genericWake(Context c, String wake) {
        post(c, wake, "", "activity", "Chama", c.getString(R.string.push_activity), false);
    }

    private static String post(Context c, String wake, String trade, String tag, String title, String body, boolean test) {
        return post(c, wake, trade, tag, title, body, test, "");
    }
    private static String post(Context c, String wake, String trade, String tag, String title, String body, boolean test, String group) {
        return post(c, wake, trade, tag, title, body, test, group, null);
    }
    private static String post(Context c, String wake, String trade, String tag, String title, String body, boolean test, String group, JSONObject note) {
        return post(c, wake, trade, tag, title, body, test, group, note, false);
    }
    private static synchronized String post(Context c, String wake, String trade, String tag, String title, String body, boolean test, String group, JSONObject note, boolean foregroundChat) {
        int id = ChamaWakePolicy.notificationId(trade, tag);
        String reason = ChamaWakePolicy.reason(trade, tag);
        String key = "posted:" + id;
        String verdict = foregroundChat ? ChamaWakePolicy.verdict(true, false,
            NotificationManagerCompat.from(c).areNotificationsEnabled() && channelEnabled(c), false, 0, System.currentTimeMillis())
            : policy(c, test, trade.isEmpty() ? prefs(c).getLong(key, 0) : 0);
        if (reason.equals("chat") && note != null) {
            try {
                JSONArray fired = new JSONArray(prefs(c).getString("wakeFired", "[]"));
                for (int i = 0; i < fired.length(); i++) if (tag.equals(fired.optString(i))) {
                    log(c, wake, "duplicate", "shared chat poster", id, reason); return "duplicate";
                }
            } catch (Exception ignored) { }
        }
        if (!"shown".equals(verdict)) { log(c, wake, verdict, null, null, reason); return verdict; }
        if (android.os.Build.VERSION.SDK_INT >= 26) c.getSystemService(NotificationManager.class).createNotificationChannel(
            new NotificationChannel("chama_activity", "Chama", NotificationManager.IMPORTANCE_DEFAULT));
        Intent intent = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (!trade.isEmpty()) intent.setAction(Intent.ACTION_VIEW).setData(android.net.Uri.parse("https://getchama.app/?trade=" + trade));
        PendingIntent open = PendingIntent.getActivity(c, id, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        try {
            NotificationManagerCompat manager = NotificationManagerCompat.from(c);
            boolean chat = reason.equals("chat");
            String notificationGroup = group.isEmpty() && !trade.isEmpty() ? "chama-trade:" + trade : group;
            NotificationCompat.Builder builder = new NotificationCompat.Builder(c, "chama_activity")
                .setSmallIcon(R.drawable.ic_chama_notification).setContentTitle(title)
                .setContentText(body).setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setGroup(notificationGroup.isEmpty() ? null : notificationGroup).setContentIntent(open)
                .setAutoCancel(true).setOnlyAlertOnce(false);
            if (chat && note != null) {
                JSONArray lines;
                try { lines = new JSONArray(prefs(c).getString("tradeChat:" + trade, "[]")); }
                catch (Exception e) { lines = new JSONArray(); }
                JSONArray bounded = new JSONArray();
                for (int i = Math.max(0, lines.length() - 9); i < lines.length(); i++) bounded.put(lines.opt(i));
                bounded.put(new JSONObject().put("sender", note.optString("sender", "Your trading partner"))
                    .put("text", note.optString("message", body)).put("time", note.optLong("sentAt", System.currentTimeMillis())));
                NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(new Person.Builder().setName("You").build());
                for (int i = 0; i < bounded.length(); i++) {
                    JSONObject line = bounded.getJSONObject(i);
                    style.addMessage(line.getString("text"), line.getLong("time"), new Person.Builder().setName(line.getString("sender")).build());
                }
                builder.setStyle(style);
                prefs(c).edit().putString("tradeChat:" + trade, bounded.toString()).apply();
            }
            manager.notify(id, builder.build());
            if (chat && note != null) {
                JSONArray fired = new JSONArray(prefs(c).getString("wakeFired", "[]")), bounded = new JSONArray();
                for (int i = Math.max(0, fired.length() - 499); i < fired.length(); i++) bounded.put(fired.get(i));
                bounded.put(tag); prefs(c).edit().putString("wakeFired", bounded.toString()).apply();
            }
            if (!group.isEmpty()) manager.notify(group.hashCode(), new NotificationCompat.Builder(c, "chama_activity")
                .setSmallIcon(R.drawable.ic_chama_notification).setContentTitle("New listings")
                .setContentText("New offers in your community").setGroup(group).setGroupSummary(true)
                .setContentIntent(open).setAutoCancel(true).setOnlyAlertOnce(true).build());
            if (ChamaWakePolicy.replacesState(trade, tag, group)) {
                int previous = prefs(c).getInt("tradeNote:" + trade, id);
                if (previous != id) manager.cancel(previous);
                prefs(c).edit().putInt("tradeNote:" + trade, id).apply();
            }
            prefs(c).edit().putLong(key, System.currentTimeMillis()).apply();
            log(c, wake, "shown", null, id, reason);
            try {
                JSONArray rows = alertLog(c);
                for (int i = 0; i < rows.length(); i++) {
                    JSONObject row = rows.getJSONObject(i);
                    if (wake.equals(row.optString("id"))) {
                        JSONArray posts = row.getJSONArray("posts");
                        if (posts.length() > 0) posts.getJSONObject(posts.length() - 1).put("tag", tag).put("poster", "shared-native");
                    }
                }
                prefs(c).edit().putString("alertLog", rows.toString()).apply();
            } catch (Exception ignored) { }
            return "shown";
        } catch (org.json.JSONException e) {
            log(c, wake, "failed", null, null, reason);
            return "failed";
        } catch (SecurityException e) {
            log(c, wake, "notifications-disabled", null, null, reason);
            return "notifications-disabled";
        }
    }
}
