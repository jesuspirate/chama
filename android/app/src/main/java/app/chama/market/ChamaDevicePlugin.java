package app.chama.market;

import android.graphics.Color;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ChamaDevice")
public class ChamaDevicePlugin extends Plugin {
    @PluginMethod public void payment(PluginCall call) {
        String uri = call.getString("uri", "");
        if (!ChamaPaymentPolicy.validUri(uri)) { call.reject("Invalid payment link"); return; }
        boolean share = call.getBoolean("share", false);
        getActivity().runOnUiThread(() -> {
            try {
                android.content.Intent target = share
                    ? new android.content.Intent(android.content.Intent.ACTION_SEND).setType("text/plain").putExtra(android.content.Intent.EXTRA_TEXT, uri)
                    : new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(uri));
                if (!share && target.resolveActivity(getContext().getPackageManager()) == null) {
                    call.reject("No wallet available", "NO_WALLET");
                    return;
                }
                getActivity().startActivity(android.content.Intent.createChooser(target, null));
                call.resolve();
            } catch (Exception e) { call.reject("No wallet available"); }
        });
    }

    /** The local Fedimint bridge's auth token, for this app's WebView only. */
    @PluginMethod public void bridgeToken(PluginCall call) {
        JSObject result = new JSObject();
        result.put("token", ((MainActivity) getActivity()).bridgeAuthToken());
        call.resolve(result);
    }

    @PluginMethod public void setTheme(PluginCall call) {
        String color = call.getString("color", "#05050a");
        boolean light = "light".equals(call.getString("theme", "dark"));
        try {
            int value = Color.parseColor(color);
            getActivity().runOnUiThread(() -> {
                ((MainActivity) getActivity()).applySelectionTheme(light);
                getActivity().getWindow().setNavigationBarColor(value);
                getActivity().getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(value));
                call.resolve();
            });
        } catch (Exception e) { call.reject("Invalid color"); }
    }
}
