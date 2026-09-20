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
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "Chama";
    private static final String PREFS_NAME = "chama_native";
    private static final String ASSET_VERSION_KEY = "web_asset_version";
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
        super.onCreate(savedInstanceState);
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.rgb(5, 5, 10)));
        getWindow().setStatusBarColor(Color.rgb(5, 5, 10));
        getWindow().setNavigationBarColor(Color.rgb(5, 5, 10));
        if (getSupportActionBar() != null) {
            getSupportActionBar().hide();
        }
        fedimintBridgeStopping = false;
        startFedimintBridge();
    }

    @Override
    public void onResume() {
        super.onResume();
        ChamaPushStore.foreground = true;
        ChamaPushStore.retry(getApplicationContext());
        fedimintBridgeStopping = false;
        startFedimintBridge();
    }

    @Override
    public void onPause() {
        ChamaPushStore.foreground = false;
        super.onPause();
    }

    @Override
    public void onDestroy() {
        stopFedimintBridge();
        super.onDestroy();
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
