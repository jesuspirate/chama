package app.chama.market;

import android.Manifest;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.common.GoogleApiAvailabilityLight;
import com.google.android.gms.common.ConnectionResult;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import org.unifiedpush.android.connector.UnifiedPush;
import org.json.JSONObject;
import static org.unifiedpush.android.connector.ConstantsKt.INSTANCE_DEFAULT;

@CapacitorPlugin(name = "ChamaPush", permissions = {
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public class ChamaPushPlugin extends Plugin {
    private String lane() {
        boolean playReachable = GoogleApiAvailabilityLight.getInstance()
            .isGooglePlayServicesAvailable(getContext()) == ConnectionResult.SUCCESS;
        boolean firebaseReady = false;
        if (BuildConfig.HAS_FIREBASE_CONFIG && playReachable) {
            try { firebaseReady = FirebaseApp.initializeApp(getContext()) != null; }
            catch (RuntimeException ignored) { /* Preserve UnifiedPush fallback. */ }
        }
        return ChamaPushTransport.select(BuildConfig.HAS_FIREBASE_CONFIG, playReachable,
            firebaseReady, !UnifiedPush.getDistributors(getContext()).isEmpty());
    }

    @PluginMethod public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("lane", lane());
        result.put("alertLog", ChamaPushStore.alertLog(getContext()));
        result.put("registerHttpStatus", ChamaPushStore.prefs(getContext()).getInt("registerHttpStatus", 0));
        try { result.put("registeredTags", new org.json.JSONArray(ChamaPushStore.prefs(getContext()).getString("registeredTags", "[]"))); }
        catch (Exception ignored) { result.put("registeredTags", new org.json.JSONArray()); }
        result.put("notificationsEnabled", androidx.core.app.NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
        result.put("channelEnabled", ChamaPushStore.channelEnabled(getContext()));
        result.put("testHttpStatus", ChamaPushStore.prefs(getContext()).getInt("testHttpStatus", 0));
        result.put("testHttpNonce", ChamaPushStore.prefs(getContext()).getString("testHttpNonce", ""));
        result.put("testReceived", ChamaPushStore.prefs(getContext()).getString("testReceived", ""));
        try {
            result.put("ntfy", new JSONObject(ChamaPushStore.prefs(getContext()).getString("endpoint", "{}"))
                .optString("endpoint").startsWith("https://ntfy.sh/"));
        } catch (Exception ignored) { }
        result.put("ready", !ChamaPushStore.prefs(getContext()).getString("endpoint", "").isEmpty());
        result.put("registered", ChamaPushStore.prefs(getContext()).getBoolean("registered", false));
        call.resolve(result);
    }

    private String pendingTrade;
    @Override public void load() { readTradeIntent(getActivity().getIntent()); }
    @Override protected void handleOnNewIntent(android.content.Intent intent) { readTradeIntent(intent); }
    private void readTradeIntent(android.content.Intent intent) {
        if (intent == null || intent.getData() == null) return;
        String trade = intent.getData().getQueryParameter("trade");
        if (trade == null || !trade.matches("(?i)sm_[a-z0-9_]+")) return;
        pendingTrade = trade;
        JSObject result = new JSObject(); result.put("trade", trade);
        notifyListeners("tradeOpened", result, true);
    }
    @PluginMethod public void takeTrade(PluginCall call) {
        JSObject result = new JSObject(); result.put("trade", pendingTrade); pendingTrade = null; call.resolve(result);
    }

    @PluginMethod public void crash(PluginCall call) {
        // Only metadata supplied by the WebView reporter, never exception messages.
        String kind = call.getString("exceptionClass", "Error");
        if (!kind.matches("[A-Za-z0-9_.$]{1,100}")) kind = "Error";
        String frame = call.getString("topFrame", "unknown");
        if (!frame.matches("[A-Za-z0-9_.$(): /-]{1,200}")) frame = "unknown";
        ChamaPushStore.crash(getContext(), kind, frame);
        call.resolve();
    }

    @PluginMethod public void diagnostic(PluginCall call) {
        try {
            JSONObject detail = new JSONObject(call.getString("diagnostic", "{}"));
            synchronized (ChamaPushStore.class) {
                boolean walletStorage = "saved-wallets".equals(detail.optString("area"));
                boolean alertPost = "alert-post".equals(detail.optString("area"));
                String id = ChamaPushStore.beginWake(getContext(), alertPost ? "foreground-listing" : walletStorage ? "saved-wallets" : "funding");
                org.json.JSONArray rows = ChamaPushStore.alertLog(getContext());
                for (int i = 0; i < rows.length(); i++) {
                    JSONObject row = rows.getJSONObject(i);
                    if (id.equals(row.optString("id"))) {
                        row.put("diagnostic", detail).put("verdict", "recorded")
                            .put("job", alertPost ? "foreground listing" : walletStorage ? "wallet storage" : "funding receive");
                        if (alertPost) row.getJSONArray("posts").put(new JSONObject().put("reason", "listing")
                            .put("verdict", detail.optString("verdict")).put("tag", detail.optString("tag"))
                            .put("poster", detail.optString("poster")).put("notificationId", detail.optInt("notificationId")));
                    }
                }
                ChamaPushStore.prefs(getContext()).edit().putString("alertLog", rows.toString()).apply();
            }
            call.resolve();
        } catch (Exception e) { call.reject("Invalid diagnostics"); }
    }

    @PluginMethod public void postChat(PluginCall call) {
        try {
            JSONObject note = new JSONObject(call.getString("note", "{}"));
            String trade = note.getString("escrowId"), tag = note.getString("tag");
            if (!trade.matches("(?i)sm_[a-z0-9_]+") || !ChamaWakePolicy.reason(trade, tag).equals("chat")) {
                call.reject("Invalid chat notification"); return;
            }
            String wake = ChamaPushStore.beginWake(getContext(), "foreground-chat");
            String verdict = ChamaPushStore.postForegroundChat(getContext(), wake, note);
            ChamaPushStore.jobDetails(getContext(), wake, new org.json.JSONArray().put(tag), verdict, 0);
            JSObject result = new JSObject(); result.put("verdict", verdict); call.resolve(result);
        } catch (Exception e) { call.reject("Chat notification failed"); }
    }

    @PluginMethod public void clearTrade(PluginCall call) {
        String trade = call.getString("trade", "");
        if (!trade.matches("(?i)sm_[a-z0-9_]+")) { call.reject("Invalid trade"); return; }
        ChamaPushStore.clearTrade(getContext(), trade);
        call.resolve();
    }

    @PluginMethod public void snapshot(PluginCall call) {
        synchronized (ChamaPushStore.class) {
        String next = call.getString("snapshot", "");
        android.content.SharedPreferences prefs = ChamaPushStore.prefs(getContext());
        android.content.SharedPreferences.Editor edit = prefs.edit().putString("snapshot", next);
        try {
            String oldKey = new JSONObject(prefs.getString("snapshot", "{}")).optString("pubkey");
            String newKey = next.isEmpty() ? "" : new JSONObject(next).optString("pubkey");
            if (!oldKey.equals(newKey)) edit.remove("lastWake").remove("wakeFired");
        } catch (Exception ignored) { edit.remove("lastWake").remove("wakeFired"); }
        edit.apply();
        call.resolve();
        }
    }

    @PluginMethod public void test(PluginCall call) {
        if (!ChamaPushStore.enabled(getContext())) { call.reject("Alerts are off"); return; }
        String nonce = java.util.UUID.randomUUID().toString().replace("-", "");
        ChamaPushStore.prefs(getContext()).edit().putString("testPending", nonce).remove("testReceived").remove("testHttpStatus").remove("testHttpNonce").apply();
        ChamaPushStore.test(getContext(), nonce);
        JSObject result = new JSObject(); result.put("nonce", nonce); call.resolve(result);
    }

    @PluginMethod public void enable(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "permissionResult");
        } else subscribe(call);
    }

    @PermissionCallback private void permissionResult(PluginCall call) {
        if (getPermissionState("notifications") == PermissionState.GRANTED) subscribe(call);
        else call.reject("Notification permission denied");
    }

    private void subscribe(PluginCall call) {
        String transport = lane();
        if (transport.equals("unavailable")) { call.reject("Install a UnifiedPush distributor or configure Firebase with Play services"); return; }
        if (!transport.equals(ChamaPushStore.prefs(getContext()).getString("lane", ""))) {
            ChamaPushStore.prefs(getContext()).edit().remove("endpoint").apply();
        }
        ChamaPushStore.prefs(getContext()).edit().putBoolean("enabled", true).putString("lane", transport).apply();
        ChamaPushStore.retry(getContext());
        if (transport.equals("fcm")) {
            FirebaseMessaging.getInstance().setAutoInitEnabled(true);
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                if (!task.isSuccessful()) { call.reject("FCM registration failed"); return; }
                try {
                    ChamaPushStore.endpoint(getContext(), new JSONObject().put("transport", "fcm").put("token", task.getResult()));
                    call.resolve();
                } catch (Exception e) { call.reject("FCM registration failed"); }
            });
        } else {
            getActivity().runOnUiThread(() -> UnifiedPush.tryUseCurrentOrDefaultDistributor(getActivity(), success -> {
                if (success) {
                    UnifiedPush.register(getContext(), INSTANCE_DEFAULT, "Chama", call.getString("vapid"));
                    call.resolve(); // Endpoint arrives asynchronously; status.ready acknowledges it.
                } else call.reject("No UnifiedPush distributor selected");
                return kotlin.Unit.INSTANCE;
            }));
        }
    }

    @PluginMethod public void register(PluginCall call) { updateTags(call, true); }
    @PluginMethod public void unregister(PluginCall call) { updateTags(call, false); }
    private void updateTags(PluginCall call, boolean add) {
        if (add && !ChamaPushStore.enabled(getContext())) { call.reject("Background alerts are off"); return; }
        try {
            ChamaPushStore.tags(getContext(), call.getArray("tags"), add);
            call.resolve();
        } catch (Exception e) { call.reject("Invalid wake tags"); }
    }

    @PluginMethod public void disable(PluginCall call) {
        // Keep the distributor subscription/token for a later enable. The store
        // removes server watches and all delivery paths honor enabled=false.
        ChamaPushStore.disable(getContext());
        call.resolve();
    }
}
