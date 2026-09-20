package app.chama.market;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import org.json.JSONObject;

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
        ChamaPushStore.wake(this);
    }
}
