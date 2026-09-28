package app.chama.market;

import android.graphics.Color;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ChamaDevice")
public class ChamaDevicePlugin extends Plugin {
    @PluginMethod public void setTheme(PluginCall call) {
        String color = call.getString("color", "#05050a");
        try {
            int value = Color.parseColor(color);
            getActivity().runOnUiThread(() -> {
                getActivity().getWindow().setNavigationBarColor(value);
                getActivity().getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(value));
                call.resolve();
            });
        } catch (Exception e) { call.reject("Invalid color"); }
    }
}
