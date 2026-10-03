package app.chama.market;

import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class ChamaPushTransportTest {
    @Test public void fcmWinsWhenBothTransportsExist() {
        assertEquals("fcm", ChamaPushTransport.select(true, true, true, true));
    }
    @Test public void missingConfigOrPlayOrInitializationFallsBack() {
        assertEquals("unifiedpush", ChamaPushTransport.select(false, true, true, true));
        assertEquals("unifiedpush", ChamaPushTransport.select(true, false, false, true));
        assertEquals("unifiedpush", ChamaPushTransport.select(true, true, false, true));
        assertEquals("unavailable", ChamaPushTransport.select(false, false, false, false));
    }
}
