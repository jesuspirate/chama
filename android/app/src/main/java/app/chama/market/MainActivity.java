package app.chama.market;

import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Window;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "Chama";
    private static final String PREFS_NAME = "chama_native";
    private static final String ASSET_VERSION_KEY = "web_asset_version";
    private static final String BRIDGE_AUTH_TOKEN_KEY = "fedimint_bridge_auth_token";
    private static final String FEDIMINT_BRIDGE_BINARY = "libchama_fedimint_bridge.so";
    private static final String FEDIMINT_BRIDGE_BIND = "127.0.0.1:8787";
    private static final long FEDIMINT_BRIDGE_STABLE_MS = 30_000L;
    private static final long FEDIMINT_BRIDGE_MAX_RESTART_DELAY_MS = 30_000L;

    private Process fedimintBridgeProcess;
    private final Handler fedimintBridgeHandler = new Handler(Looper.getMainLooper());
    private int fedimintBridgeRestartAttempts = 0;
    private boolean fedimintBridgeStopping = false;
    private final Runnable fedimintBridgeRestartRunnable = this::startFedimintBridge;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        supportRequestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.rgb(5, 5, 10)));
        clearWebViewCacheAfterAppUpdate();
        registerPlugin(ChamaPushPlugin.class);
        registerPlugin(ChamaDevicePlugin.class);
        super.onCreate(savedInstanceState);
        applySelectionTheme(getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean("lightTheme", false));
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.rgb(5, 5, 10)));
        getWindow().setStatusBarColor(Color.rgb(5, 5, 10));
        getWindow().setNavigationBarColor(Color.rgb(5, 5, 10));
        if (getSupportActionBar() != null) {
            getSupportActionBar().hide();
        }
        fedimintBridgeStopping = false;
        startFedimintBridge();
    }

    @Override public void onStart() {
        super.onStart();
        ChamaPushStore.activityStarted = true;
        ChamaPushStore.foregroundBranch = "started";
    }
    @Override public void onPause() {
        ChamaPushStore.foregroundBranch = "started";
        super.onPause();
    }
    @Override public void onStop() {
        ChamaPushStore.activityStarted = false;
        ChamaPushStore.foregroundBranch = "no activity";
        super.onStop();
    }

    @Override
    public void onResume() {
        super.onResume();
        ChamaPushStore.activityStarted = true;
        ChamaPushStore.foregroundBranch = "resumed";
        if (bridge != null) bridge.triggerWindowJSEvent("chama:resume");
        ChamaPushStore.retry(getApplicationContext());
        fedimintBridgeStopping = false;
        startFedimintBridge();
    }

    @Override
    public void onDestroy() {
        ChamaPushStore.activityStarted = false;
        ChamaPushStore.foregroundBranch = "no activity";
        stopFedimintBridge();
        super.onDestroy();
    }

    private android.view.ActionMode selectionActionMode;
    private Boolean selectionLight;

    /** Match native selection controls to the app, independent of system night mode. */
    void applySelectionTheme(boolean light) {
        if (selectionLight != null && selectionLight == light) return;
        if (selectionActionMode != null) selectionActionMode.finish();
        int overlay = light ? R.style.ChamaSelectionLight : R.style.ChamaSelectionDark;
        getTheme().applyStyle(overlay, true);
        getWindow().getContext().getTheme().applyStyle(overlay, true);
        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().getContext().getTheme().applyStyle(overlay, true);
        }
        selectionLight = light;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean("lightTheme", light).apply();
    }

    @Override public void onActionModeStarted(android.view.ActionMode mode) {
        super.onActionModeStarted(mode);
        selectionActionMode = mode;
    }

    @Override public void onActionModeFinished(android.view.ActionMode mode) {
        if (selectionActionMode == mode) selectionActionMode = null;
        super.onActionModeFinished(mode);
    }

    @Override public void onConfigurationChanged(android.content.res.Configuration config) {
        super.onConfigurationChanged(config);
        // AppCompat may reapply DayNight after a system-theme change.
        boolean light = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean("lightTheme", false);
        selectionLight = null;
        applySelectionTheme(light);
    }

    /** Stable per-install bridge token, kept in app-private preferences so a
     *  bridge that outlives the activity still accepts the WebView. */
    synchronized String bridgeAuthToken() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String token = prefs.getString(BRIDGE_AUTH_TOKEN_KEY, null);
        if (token != null && token.length() >= 64) return token;
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        StringBuilder hex = new StringBuilder(64);
        for (byte b : bytes) hex.append(String.format("%02x", b));
        token = hex.toString();
        prefs.edit().putString(BRIDGE_AUTH_TOKEN_KEY, token).commit();
        return token;
    }

    private synchronized void startFedimintBridge() {
        fedimintBridgeHandler.removeCallbacks(fedimintBridgeRestartRunnable);
        if (fedimintBridgeProcess != null && fedimintBridgeProcess.isAlive()) {
            return;
        }

        File bridgeBinary = new File(getApplicationInfo().nativeLibraryDir, FEDIMINT_BRIDGE_BINARY);
        if (!bridgeBinary.exists()) {
            Log.w(TAG, "Native Fedimint bridge binary not packaged: " + bridgeBinary.getAbsolutePath());
            return;
        }

        File dataDir = new File(getFilesDir(), "fedimint-bridge");
        if (!dataDir.exists() && !dataDir.mkdirs()) {
            Log.e(TAG, "Could not create Fedimint bridge data dir: " + dataDir.getAbsolutePath());
            return;
        }

        List<String> command = new ArrayList<>();
        command.add(bridgeBinary.getAbsolutePath());
        command.add("--data-dir");
        command.add(dataDir.getAbsolutePath());
        command.add("serve");
        command.add("--bind");
        command.add(FEDIMINT_BRIDGE_BIND);

        ProcessBuilder builder = new ProcessBuilder(command);
        builder.redirectErrorStream(true);
        builder.environment().put("RUST_LOG", "warn");
        // Every bridge route needs this token. Without it, any other app on
        // the phone (or a web page via the system browser) could call
        // 127.0.0.1:8787 and spend, withdraw or reset the wallet. The token
        // travels by environment, never argv, and reaches only this app's
        // WebView through ChamaDevicePlugin.bridgeToken().
        builder.environment().put("CHAMA_BRIDGE_AUTH_TOKEN", bridgeAuthToken());
        builder.environment().put("LD_LIBRARY_PATH", getApplicationInfo().nativeLibraryDir);

        try {
            fedimintBridgeProcess = builder.start();
            streamFedimintBridgeLogs(fedimintBridgeProcess);
            scheduleFedimintBridgeStableReset(fedimintBridgeProcess);
            Log.i(TAG, "Native Fedimint bridge launching on http://" + FEDIMINT_BRIDGE_BIND);
        } catch (Exception e) {
            fedimintBridgeProcess = null;
            Log.e(TAG, "Failed to start native Fedimint bridge", e);
            scheduleFedimintBridgeRestart("start failure");
        }
    }

    private void streamFedimintBridgeLogs(Process process) {
        Thread thread = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream())
            )) {
                String line;
                while ((line = reader.readLine()) != null) {
                    Log.i(TAG, "fedimint-bridge: " + line);
                }
                int exitCode = process.waitFor();
                Log.w(TAG, "Native Fedimint bridge exited with code " + exitCode);
                synchronized (MainActivity.this) {
                    if (fedimintBridgeProcess == process) {
                        fedimintBridgeProcess = null;
                        scheduleFedimintBridgeRestart("exit code " + exitCode);
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "Fedimint bridge log stream ended", e);
                synchronized (MainActivity.this) {
                    if (fedimintBridgeProcess == process) {
                        fedimintBridgeProcess = null;
                        scheduleFedimintBridgeRestart("log stream ended");
                    }
                }
            }
        }, "chama-fedimint-bridge-log");
        thread.setDaemon(true);
        thread.start();
    }

    private synchronized void stopFedimintBridge() {
        fedimintBridgeStopping = true;
        fedimintBridgeHandler.removeCallbacks(fedimintBridgeRestartRunnable);
        if (fedimintBridgeProcess == null) {
            return;
        }
        fedimintBridgeProcess.destroy();
        fedimintBridgeProcess = null;
    }

    private synchronized void scheduleFedimintBridgeRestart(String reason) {
        if (fedimintBridgeStopping) {
            return;
        }

        fedimintBridgeRestartAttempts += 1;
        long delayMs = Math.min(
            FEDIMINT_BRIDGE_MAX_RESTART_DELAY_MS,
            1_000L << Math.min(fedimintBridgeRestartAttempts - 1, 5)
        );
        Log.w(
            TAG,
            "Scheduling Native Fedimint bridge restart in " + delayMs + "ms after " + reason
        );
        fedimintBridgeHandler.removeCallbacks(fedimintBridgeRestartRunnable);
        fedimintBridgeHandler.postDelayed(fedimintBridgeRestartRunnable, delayMs);
    }

    private void scheduleFedimintBridgeStableReset(Process process) {
        fedimintBridgeHandler.postDelayed(() -> {
            synchronized (MainActivity.this) {
                if (fedimintBridgeProcess == process && process.isAlive()) {
                    fedimintBridgeRestartAttempts = 0;
                }
            }
        }, FEDIMINT_BRIDGE_STABLE_MS);
    }

    private void clearWebViewCacheAfterAppUpdate() {
        String currentVersion = getAppVersionName();
        if (currentVersion == null || currentVersion.isEmpty()) {
            return;
        }

        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String previousVersion = prefs.getString(ASSET_VERSION_KEY, "");
        if (currentVersion.equals(previousVersion)) {
            return;
        }

        try {
            WebView webView = new WebView(this);
            webView.clearCache(true);
            webView.destroy();
        } catch (Exception ignored) {
            // Best effort: stale web assets should never block app startup.
        }

        prefs.edit().putString(ASSET_VERSION_KEY, currentVersion).apply();
    }

    private String getAppVersionName() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            return info.versionName;
        } catch (Exception ignored) {
            return null;
        }
    }
}
