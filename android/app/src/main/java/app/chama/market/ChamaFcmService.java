package app.chama.market;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import org.json.JSONObject;
import org.json.JSONArray;

public class ChamaFcmService extends FirebaseMessagingService {
    @Override public void onNewToken(String token) {
        if (!"fcm".equals(ChamaPushStore.prefs(this).getString("lane", ""))) return;
        try { ChamaPushStore.endpoint(this, new JSONObject().put("transport", "fcm").put("token", token)); }
        catch (Exception ignored) { }
    }
    @Override public void onMessageReceived(RemoteMessage message) {
        // Data-only messages: Firebase must never display unvetted notification copy.
        if (!"1".equals(message.getData().get("wake"))) return;
        if (!"fcm".equals(ChamaPushStore.prefs(this).getString("lane", ""))) return;
        if (!ChamaWakePolicy.fresh(message.getSentTime(), System.currentTimeMillis())) return;
        try {
            JSONArray tags = new JSONArray(message.getData().getOrDefault("tags", "[]"));
            if (!ChamaPushStore.testReply(this, message.getData().get("test"), "fcm")) ChamaPushStore.wake(this, "fcm", tags);
        } catch (Exception ignored) { /* Malformed opaque tags: stay quiet. */ }
    }
}
