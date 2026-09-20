package app.chama.market;

import org.junit.Test;
import static org.junit.Assert.*;

public class ChamaWakePolicyTest {
    @Test public void staleAndFuturePayloadsStayQuiet() {
        assertFalse(ChamaWakePolicy.fresh(0, 200_000));
        assertFalse(ChamaWakePolicy.fresh(79_999, 200_000));
        assertFalse(ChamaWakePolicy.fresh(200_001, 200_000));
        assertTrue(ChamaWakePolicy.fresh(199_000, 200_000));
    }
    @Test public void optInForegroundAndBurstBoundaries() {
        assertFalse(ChamaWakePolicy.mayDisplay(false, false, 0, 200_000));
        assertFalse(ChamaWakePolicy.mayDisplay(true, true, 0, 200_000));
        assertFalse(ChamaWakePolicy.mayDisplay(true, false, 196_000, 200_000));
        assertTrue(ChamaWakePolicy.mayDisplay(true, false, 195_000, 200_000));
    }
}
