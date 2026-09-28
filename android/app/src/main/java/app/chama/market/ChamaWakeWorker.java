package app.chama.market;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.webkit.*;
import androidx.annotation.NonNull;
import androidx.work.*;
import org.json.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** A separate, read-only JS entry point. Never creates MainActivity or the wallet bridge. */
public class ChamaWakeWorker extends Worker {
    public ChamaWakeWorker(@NonNull Context context, @NonNull WorkerParameters params) { super(context, params); }
    static void enqueue(Context context, String wake) {
        OneTimeWorkRequest.Builder request = new OneTimeWorkRequest.Builder(ChamaWakeWorker.class)
            .setInputData(new Data.Builder().putString("wake", wake).build())
            .setBackoffCriteria(BackoffPolicy.LINEAR, 10, TimeUnit.SECONDS);
        if (android.os.Build.VERSION.SDK_INT >= 31) request.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST);
        WorkManager.getInstance(context).enqueueUniqueWork("chama-wake", ExistingWorkPolicy.APPEND_OR_REPLACE, request.build());
    }
    @NonNull @Override public Result doWork() {
        Context c = getApplicationContext();
        String wake = getInputData().getString("wake");
        String verdict = ChamaPushStore.policy(c, false, 0);
        if (!"shown".equals(verdict)) {
            ChamaPushStore.log(c, wake, verdict, "not run", null, null);
            return Result.success();
        }
        ChamaPushStore.log(c, wake, "pending", "running", null, null);
        long started = System.currentTimeMillis();
        Handler main = new Handler(Looper.getMainLooper());
        CountDownLatch done = new CountDownLatch(1);
        AtomicBoolean finished = new AtomicBoolean();
        WebView[] view = new WebView[1];
        String[] result = new String[1];
        String snapshot = ChamaPushStore.prefs(c).getString("snapshot", "");
        try {
            JSONObject input = new JSONObject().put("snapshot", new JSONObject(snapshot))
                .put("lastWake", ChamaPushStore.prefs(c).getLong("lastWake", 0))
                .put("fired", new JSONArray(ChamaPushStore.prefs(c).getString("wakeFired", "[]")))
                .put("nsec", c.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE).getString("chama_saved_nsec", ""));
            main.post(() -> {
                if (finished.get()) return;
                try {
                    WebView web = new WebView(c); view[0] = web;
                    web.getSettings().setJavaScriptEnabled(true);
                    web.getSettings().setAllowFileAccess(false);
                    web.getSettings().setAllowContentAccess(false);
                    web.getSettings().setDomStorageEnabled(false);
                    web.addJavascriptInterface(new Object() {
                        @JavascriptInterface public String input() { return finished.get() ? "{}" : input.toString(); }
                        @JavascriptInterface public void finish(String value) {
                            if (finished.compareAndSet(false, true)) { result[0] = value; done.countDown(); }
                        }
                    }, "ChamaWake");
                    web.setWebViewClient(new WebViewClient() {
                        @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) { return true; }
                        @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                            String path = request.getUrl().getPath();
                            try {
                                if (!"wake.chama.invalid".equals(request.getUrl().getHost()) || path == null
                                    || path.contains("..") || !(path.equals("/wake.html") || path.startsWith("/assets/")))
                                    return new WebResourceResponse("text/plain", "UTF-8", new java.io.ByteArrayInputStream(new byte[0]));
                                return new WebResourceResponse(path.endsWith(".js") ? "application/javascript" : "text/html", "UTF-8",
                                    c.getAssets().open("public" + path));
                            } catch (Exception e) { return new WebResourceResponse("text/plain", "UTF-8", new java.io.ByteArrayInputStream(new byte[0])); }
                        }
                    });
                    web.loadUrl("https://wake.chama.invalid/wake.html");
                } catch (Exception e) { done.countDown(); }
            });
            done.await(Math.max(1, 7800 - (System.currentTimeMillis() - started)), TimeUnit.MILLISECONDS);
            finished.set(true);
            verdict = ChamaPushStore.policy(c, false, 0);
            if (!"shown".equals(verdict) || !snapshot.equals(ChamaPushStore.prefs(c).getString("snapshot", ""))) {
                ChamaPushStore.log(c, wake, "shown".equals(verdict) ? "cancelled" : verdict, "app state changed", null, null);
                return Result.success();
            }
            JSONObject output = result[0] == null ? null : new JSONObject(result[0]);
            if (output == null || output.optBoolean("failed")) {
                ChamaPushStore.log(c, wake, null, output == null ? "timeout" : "replay failed", null, null);
                ChamaPushStore.genericWake(c, wake);
            }
            else {
                JSONArray notes = output.getJSONArray("notifications");
                JSONArray fired = new JSONArray(ChamaPushStore.prefs(c).getString("wakeFired", "[]"));
                ChamaPushStore.log(c, wake, "nothing-new", notes.length() == 0 ? "nothing new" : notes.length() + " alert(s) found", null, null);
                boolean retry = false;
                for (int i = 0; i < notes.length(); i++) {
                    JSONObject note = notes.getJSONObject(i);
                    String posted = ChamaPushStore.postTrade(c, wake, note);
                    if ("shown".equals(posted)) fired.put(note.getString("tag"));
                    if ("rate-limited".equals(posted)) retry = true;
                }
                JSONArray bounded = new JSONArray();
                for (int i = Math.max(0, fired.length() - 500); i < fired.length(); i++) bounded.put(fired.get(i));
                ChamaPushStore.prefs(c).edit().putString("wakeFired", bounded.toString()).apply();
                if (retry) return Result.retry();
                ChamaPushStore.prefs(c).edit().putLong("lastWake", started).apply();
            }
        } catch (Exception e) {
            ChamaPushStore.log(c, wake, null, "replay failed", null, null);
            ChamaPushStore.genericWake(c, wake);
        }
        finally {
            finished.set(true);
            main.post(() -> { if (view[0] != null) { view[0].removeJavascriptInterface("ChamaWake"); view[0].destroy(); } });
        }
        return Result.success();
    }
}
