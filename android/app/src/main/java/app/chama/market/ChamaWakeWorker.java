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
    static void enqueue(Context context) {
        OneTimeWorkRequest.Builder request = new OneTimeWorkRequest.Builder(ChamaWakeWorker.class);
        if (android.os.Build.VERSION.SDK_INT >= 31) request.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST);
        WorkManager.getInstance(context).enqueueUniqueWork("chama-wake", ExistingWorkPolicy.KEEP, request.build());
    }
    @NonNull @Override public Result doWork() {
        Context c = getApplicationContext();
        if (!ChamaPushStore.enabled(c) || ChamaPushStore.foreground) return Result.success();
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
            if (!ChamaPushStore.enabled(c) || ChamaPushStore.foreground
                || !snapshot.equals(ChamaPushStore.prefs(c).getString("snapshot", ""))) return Result.success();
            JSONObject output = result[0] == null ? null : new JSONObject(result[0]);
            if (output == null || output.optBoolean("failed")) ChamaPushStore.genericWake(c);
            else {
                JSONArray notes = output.getJSONArray("notifications");
                JSONArray fired = new JSONArray(ChamaPushStore.prefs(c).getString("wakeFired", "[]"));
                for (int i = 0; i < notes.length(); i++) {
                    JSONObject note = notes.getJSONObject(i);
                    if (ChamaPushStore.postTrade(c, note)) fired.put(note.getString("tag"));
                }
                JSONArray bounded = new JSONArray();
                for (int i = Math.max(0, fired.length() - 500); i < fired.length(); i++) bounded.put(fired.get(i));
                ChamaPushStore.prefs(c).edit().putString("wakeFired", bounded.toString()).putLong("lastWake", started).apply();
            }
        } catch (Exception e) { ChamaPushStore.genericWake(c); }
        finally {
            finished.set(true);
            main.post(() -> { if (view[0] != null) { view[0].removeJavascriptInterface("ChamaWake"); view[0].destroy(); } });
        }
        return Result.success();
    }
}
