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
        if (GoogleApiAvailabilityLight.getInstance().isGooglePlayServicesAvailable(getContext()) == ConnectionResult.SUCCESS
            && FirebaseApp.initializeApp(getContext()) != null) return "fcm";
        return UnifiedPush.getDistributors(getContext()).isEmpty() ? "unavailable" : "unifiedpush";
    }

    @PluginMethod public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("lane", lane());
        result.put("ready", !ChamaPushStore.prefs(getContext()).getString("endpoint", "").isEmpty());
        result.put("registered", ChamaPushStore.prefs(getContext()).getBoolean("registered", false));
        call.resolve(result);
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
        ChamaPushStore.prefs(getContext()).edit().putBoolean("enabled", true).putString("lane", transport).apply();
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
        String oldLane = ChamaPushStore.prefs(getContext()).getString("lane", "");
        ChamaPushStore.disable(getContext());
        if (oldLane.equals("unifiedpush")) UnifiedPush.unregister(getContext(), INSTANCE_DEFAULT);
        if (oldLane.equals("fcm") && !FirebaseApp.getApps(getContext()).isEmpty()) {
            FirebaseMessaging.getInstance().setAutoInitEnabled(false);
            FirebaseMessaging.getInstance().deleteToken();
        }
        call.resolve();
    }
}
