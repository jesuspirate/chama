package app.chama.market;

import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;
import org.unifiedpush.android.connector.FailedReason;
import org.json.JSONObject;
import static org.unifiedpush.android.connector.ConstantsKt.INSTANCE_DEFAULT;

public class ChamaUnifiedPushService extends PushService {
    @Override public void onNewEndpoint(PushEndpoint endpoint, String instance) {
        if (!INSTANCE_DEFAULT.equals(instance) || endpoint.getPubKeySet() == null
            || !"unifiedpush".equals(ChamaPushStore.prefs(this).getString("lane", ""))) return;
        try {
            JSONObject sub = new JSONObject().put("endpoint", endpoint.getUrl()).put("transport", "unifiedpush");
            if (endpoint.getPubKeySet() != null) sub.put("keys", new JSONObject()
                .put("p256dh", endpoint.getPubKeySet().getPubKey()).put("auth", endpoint.getPubKeySet().getAuth()));
            ChamaPushStore.endpoint(this, sub);
        } catch (Exception ignored) { }
    }
    @Override public void onMessage(PushMessage message, String instance) {
        if (!INSTANCE_DEFAULT.equals(instance) || !message.getDecrypted()
            || !"unifiedpush".equals(ChamaPushStore.prefs(this).getString("lane", ""))) return;
        try {
            JSONObject payload = new JSONObject(new String(message.getContent(), java.nio.charset.StandardCharsets.UTF_8));
            if (payload.optInt("wake") == 1 && ChamaWakePolicy.fresh(payload.getLong("sentAt"), System.currentTimeMillis())) ChamaPushStore.wake(this);
        } catch (Exception ignored) { /* Invalid/legacy unauthenticated wake: stay quiet. */ }
    }
    @Override public void onRegistrationFailed(FailedReason reason, String instance) {
        if (INSTANCE_DEFAULT.equals(instance)) ChamaPushStore.prefs(this).edit().remove("endpoint").putBoolean("registered", false).apply();
    }
    @Override public void onUnregistered(String instance) {
        if (INSTANCE_DEFAULT.equals(instance)) ChamaPushStore.prefs(this).edit().remove("endpoint").putBoolean("registered", false).apply();
    }
}
