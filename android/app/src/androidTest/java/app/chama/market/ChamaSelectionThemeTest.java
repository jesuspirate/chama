package app.chama.market;

import android.content.Context;
import android.content.res.Configuration;
import android.content.res.TypedArray;
import android.view.ContextThemeWrapper;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class ChamaSelectionThemeTest {
    @Test public void selectionFollowsAppInBothSystemModes() {
        Context app = InstrumentationRegistry.getInstrumentation().getTargetContext();
        for (int night : new int[] { Configuration.UI_MODE_NIGHT_YES, Configuration.UI_MODE_NIGHT_NO }) {
            Configuration config = new Configuration(app.getResources().getConfiguration());
            config.uiMode = (config.uiMode & ~Configuration.UI_MODE_NIGHT_MASK) | night;
            ContextThemeWrapper context = new ContextThemeWrapper(app.createConfigurationContext(config), R.style.AppTheme_NoActionBar);
            for (boolean light : new boolean[] { true, false, true }) {
                context.getTheme().applyStyle(light ? R.style.ChamaSelectionLight : R.style.ChamaSelectionDark, true);
                TypedArray attrs = context.obtainStyledAttributes(new int[] { android.R.attr.isLightTheme, android.R.attr.actionModeStyle });
                assertEquals(light, attrs.getBoolean(0, !light));
                assertEquals(light ? android.R.style.Widget_Material_Light_ActionMode : android.R.style.Widget_Material_ActionMode, attrs.getResourceId(1, 0));
                attrs.recycle();
            }
        }
    }
}
